import { and, count, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { accessLists } from '@/db/schema/access-lists.js';
import { certificates } from '@/db/schema/certificates.js';
import { proxyHosts } from '@/db/schema/index.js';
import { sslCertificates } from '@/db/schema/ssl-certificates.js';
import { createChildLogger } from '@/lib/logger.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { buildWhere, escapeLike } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import type { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NginxConfigGenerator, ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { PaginatedResponse } from '@/types.js';
import type { NginxTemplateService } from './nginx-template.service.js';
import type { CreateProxyHostInput, ProxyHostListQuery, UpdateProxyHostInput } from './proxy.schemas.js';
import {
  assertSslPrerequisites,
  assertSslPrerequisitesForUpdate,
  buildStatusPageSystemHostRollbackData,
  type CertPaths,
  getStatusPageUpstream,
  normalizeProxyValidationOptions,
  type ProxyValidationInput,
  rawConfigAuditDetails,
  storedRawConfigForRawModeEnablement,
  stripProxyHealthHistory,
  updateUsesRawMode,
} from './proxy.service-helpers.js';
import {
  clearDockerUpstreamFields,
  type DockerUpstreamReference,
  type ProxyDockerUpstreamService,
} from './proxy-docker-upstream.service.js';
import { runImmediateProxyHealthCheck } from './proxy-health-check.js';
import { attachDockerUpstreamDisplay, type WithDockerUpstreamDisplay } from './proxy-upstream-display.js';

export { __testOnly } from './proxy.service-helpers.js';

const logger = createChildLogger('ProxyService');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProxyHostRow = typeof proxyHosts.$inferSelect;
type ProxyHostView = WithDockerUpstreamDisplay<ProxyHostRow>;

export interface StatusPageSystemHostInput {
  domain: string;
  nodeId: string;
  sslCertificateId?: string | null;
  nginxTemplateId?: string | null;
  upstreamUrl?: string | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ProxyService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly nginxTemplateService: NginxTemplateService,
    private readonly auditService: AuditService,
    private readonly cryptoService: CryptoService,
    private readonly configGenerator: NginxConfigGenerator,
    private readonly nodeDispatch: NodeDispatchService,
    private readonly dockerUpstreams?: ProxyDockerUpstreamService
  ) {}

  private eventBus?: EventBusService;
  private notificationEvaluator?: NotificationEvaluatorService;
  private dockerReconcileRunning = false;
  private dockerReconcileDirty = false;
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
    bus.subscribe('docker.snapshot.changed', (payload) => {
      if ((payload as { kind?: string })?.kind === 'containers') this.queueDockerReconciliation();
    });
    bus.subscribe('docker.deployment.changed', () => this.queueDockerReconciliation());
    bus.subscribe('node.service_address.changed', () => this.queueDockerReconciliation());
    bus.subscribe('docker.container.changed', (payload) => {
      const event = payload as { action?: string; nodeId?: string; name?: string; oldName?: string };
      if (event.action === 'renamed' && event.nodeId && event.name && event.oldName) {
        void this.updateRenamedContainerReferences(event.nodeId, event.oldName, event.name).catch((error) => {
          logger.error('Failed to update proxy references after container rename', { error });
        });
      }
    });
  }
  setEvaluator(evaluator: NotificationEvaluatorService) {
    this.notificationEvaluator = evaluator;
  }
  private reconcileMaintenanceAlerts(hostId?: string) {
    void this.notificationEvaluator?.reconcileProxyMaintenance(hostId).catch((error) => {
      logger.warn('Failed to reconcile proxy maintenance alerts', { hostId, error });
    });
  }
  private emitHost(id: string, action: string, domain?: string, extra: Record<string, unknown> = {}) {
    this.eventBus?.publish('proxy.host.changed', { id, action, domain, ...extra });
  }

  private async applyConfigToNode(hostId: string, config: string, nodeId: string | null): Promise<void> {
    const resolvedNodeId = await this.nodeDispatch.resolveNodeId(nodeId);
    const result = await this.nodeDispatch.applyConfig(resolvedNodeId, hostId, config);
    if (!result.success) {
      throw new Error(result.error || 'Daemon config apply failed');
    }
    await this.auditService.log({
      userId: null,
      action: 'node.config_push',
      resourceType: 'proxy_host',
      resourceId: hostId,
      details: { nodeId: resolvedNodeId },
    });
  }

  private async restoreConfigOnNode(host: ProxyHostRow): Promise<void> {
    const certPaths = await this.resolveCertPaths(host);
    const accessList = await this.resolveAccessList(host.accessListId);
    const config = await this.buildNginxConfig(host, certPaths, accessList);
    const resolvedNodeId = await this.nodeDispatch.resolveNodeId(host.nodeId);
    const result = await this.nodeDispatch.applyConfig(resolvedNodeId, host.id, config);
    if (!result.success) throw new Error(result.error || 'Daemon config rollback failed');
  }

  private async removeConfigFromNode(hostId: string, nodeId: string | null): Promise<void> {
    const resolvedNodeId = await this.nodeDispatch.resolveNodeId(nodeId);
    const result = await this.nodeDispatch.removeConfig(resolvedNodeId, hostId);
    if (!result.success) {
      throw new Error(result.error || 'Daemon config remove failed');
    }
  }

  private requireDockerUpstreams(): ProxyDockerUpstreamService {
    if (!this.dockerUpstreams) {
      throw new AppError(500, 'DOCKER_UPSTREAMS_UNAVAILABLE', 'Docker upstream resolution is unavailable');
    }
    return this.dockerUpstreams;
  }

  private async prepareCreateUpstream(input: CreateProxyHostInput, options: ProxyValidationInput) {
    const normalized = normalizeProxyValidationOptions(options);
    if (input.type !== 'proxy' || input.rawConfigEnabled) {
      return { upstreamKind: 'manual' as const, forwardHost: null, forwardPort: null, ...clearDockerUpstreamFields() };
    }
    if (input.upstreamKind === 'manual') {
      return { upstreamKind: 'manual' as const, ...clearDockerUpstreamFields() };
    }
    return this.requireDockerUpstreams().resolve(input, {
      actorScopes: normalized.actorScopes,
      requireAvailable: true,
    });
  }

  private async prepareUpdateUpstream(
    existing: ProxyHostRow,
    input: UpdateProxyHostInput,
    options: ProxyValidationInput
  ): Promise<Record<string, unknown>> {
    const normalized = normalizeProxyValidationOptions(options);
    const effectiveType = input.type ?? existing.type;
    // Raw mode is an alternate renderer for an existing host. Keep the dormant
    // upstream so disabling raw mode can restore the previous target.
    if (updateUsesRawMode(existing, input)) return {};
    if (effectiveType !== 'proxy') {
      return { upstreamKind: 'manual', forwardHost: null, forwardPort: null, ...clearDockerUpstreamFields() };
    }

    const effectiveKind = input.upstreamKind ?? existing.upstreamKind;
    if (effectiveKind === 'manual') {
      if (
        existing.upstreamKind !== 'manual' &&
        input.upstreamKind === 'manual' &&
        (input.forwardHost === undefined || input.forwardPort === undefined)
      ) {
        throw new AppError(400, 'MANUAL_UPSTREAM_REQUIRED', 'Forward host and port are required for a manual upstream');
      }
      const forwardHost = input.forwardHost === undefined ? existing.forwardHost : input.forwardHost;
      const forwardPort = input.forwardPort === undefined ? existing.forwardPort : input.forwardPort;
      if (!forwardHost || !forwardPort) {
        throw new AppError(400, 'MANUAL_UPSTREAM_REQUIRED', 'Forward host and port are required for a manual upstream');
      }
      return { upstreamKind: 'manual', forwardHost, forwardPort, ...clearDockerUpstreamFields() };
    }

    const reference: DockerUpstreamReference = {
      upstreamKind: effectiveKind,
      dockerNodeId: input.dockerNodeId === undefined ? existing.dockerNodeId : input.dockerNodeId,
      dockerContainerName:
        input.dockerContainerName === undefined ? existing.dockerContainerName : input.dockerContainerName,
      dockerDeploymentId:
        input.dockerDeploymentId === undefined ? existing.dockerDeploymentId : input.dockerDeploymentId,
      dockerContainerPort:
        input.dockerContainerPort === undefined ? existing.dockerContainerPort : input.dockerContainerPort,
      dockerHostPort: input.dockerHostPort === undefined ? existing.dockerHostPort : input.dockerHostPort,
      dockerProtocol: input.dockerProtocol === undefined ? existing.dockerProtocol : input.dockerProtocol,
    };
    const targetKeys: Array<keyof UpdateProxyHostInput> = [
      'upstreamKind',
      'dockerNodeId',
      'dockerContainerName',
      'dockerDeploymentId',
      'dockerContainerPort',
      'dockerHostPort',
      'dockerProtocol',
      'forwardHost',
      'forwardPort',
    ];
    const targetChanged =
      existing.upstreamKind !== effectiveKind || targetKeys.some((key) => Object.hasOwn(input, key));
    if (!targetChanged) return {};
    return {
      ...(await this.requireDockerUpstreams().resolve(reference, {
        actorScopes: normalized.actorScopes,
        requireAvailable: true,
      })),
    };
  }

  // -----------------------------------------------------------------------
  // Create
  // -----------------------------------------------------------------------

  async createProxyHost(input: CreateProxyHostInput, userId: string, validationOptions: ProxyValidationInput = {}) {
    const options = normalizeProxyValidationOptions(validationOptions);

    // 0. Require a node assignment
    if (!input.nodeId) {
      throw new AppError(400, 'NODE_REQUIRED', 'A node must be selected for the proxy host');
    }
    await assertNodeAllowsServiceCreation(this.db, input.nodeId, 'nginx');

    // 0b. Validate advanced config if provided
    if (input.advancedConfig && !options.bypassAdvancedValidation) {
      const validation = this.configGenerator.validateAdvancedConfig(input.advancedConfig);
      if (!validation.valid) {
        throw new AppError(
          400,
          'INVALID_ADVANCED_CONFIG',
          `Advanced config is invalid: ${validation.errors.join(', ')}`
        );
      }
    }
    if ((input as any).rawConfig) {
      const validation = this.configGenerator.validateAdvancedConfig(
        (input as any).rawConfig,
        true,
        options.bypassRawValidation === true
      );
      if (!validation.valid) {
        throw new AppError(400, 'INVALID_RAW_CONFIG', `Raw config is invalid: ${validation.errors.join(', ')}`);
      }
    }

    assertSslPrerequisites({
      sslEnabled: input.sslEnabled,
      sslCertificateId: input.sslCertificateId,
      internalCertificateId: input.internalCertificateId,
    });

    const upstreamData = await this.prepareCreateUpstream(input, options);

    // 1. Insert into DB
    const host = await writeWithAllocatedSlug({
      source: input.domainNames[0] ?? '',
      fallback: 'proxy-host',
      reserved: ['new'],
      constraint: 'proxy_hosts_slug_unique',
      write: async (slug) => {
        const [created] = await this.db
          .insert(proxyHosts)
          .values({
            type: input.type,
            nodeId: input.nodeId,
            domainNames: input.domainNames,
            slug,
            forwardHost: input.forwardHost ?? null,
            forwardPort: input.forwardPort ?? null,
            forwardScheme: input.forwardScheme,
            ...upstreamData,
            sslEnabled: input.sslEnabled,
            sslForced: input.sslForced,
            http2Support: input.http2Support,
            websocketSupport: input.websocketSupport,
            sslCertificateId: input.sslCertificateId ?? null,
            internalCertificateId: input.internalCertificateId ?? null,
            redirectUrl: input.redirectUrl ?? null,
            redirectStatusCode: input.redirectStatusCode ?? 301,
            customHeaders: input.customHeaders,
            cacheEnabled: input.cacheEnabled,
            cacheOptions: input.cacheOptions ?? null,
            rateLimitEnabled: input.rateLimitEnabled,
            rateLimitOptions: input.rateLimitOptions ?? null,
            customRewrites: input.customRewrites,
            advancedConfig: input.advancedConfig ?? null,
            rawConfig: (input as any).rawConfig ?? null,
            rawConfigEnabled: (input as any).rawConfigEnabled ?? false,
            accessListId: input.accessListId ?? null,
            folderId: input.folderId ?? null,
            nginxTemplateId: input.nginxTemplateId ?? null,
            templateVariables: input.templateVariables ?? {},
            healthCheckEnabled: input.healthCheckEnabled,
            healthCheckUrl: input.healthCheckUrl ?? '/',
            healthCheckInterval: input.healthCheckInterval ?? 30,
            healthCheckExpectedStatus: input.healthCheckExpectedStatus ?? null,
            healthCheckExpectedBody: input.healthCheckExpectedBody ?? null,
            healthCheckBodyMatchMode: input.healthCheckBodyMatchMode ?? 'includes',
            healthStatus: input.healthCheckEnabled ? 'unknown' : 'disabled',
            createdById: userId,
          })
          .returning();
        return created;
      },
    });

    // 2. Resolve SSL cert paths and build nginx config
    try {
      const certPaths = await this.resolveCertPaths(host);
      const accessList = await this.resolveAccessList(host.accessListId);
      const config = await this.buildNginxConfig(host, certPaths, accessList);

      // 3. Apply config via daemon or legacy docker
      await this.applyConfigToNode(host.id, config, host.nodeId);
    } catch (error) {
      // 4. If nginx fails, delete the DB row and throw
      logger.error('Failed to apply nginx config for new proxy host, rolling back DB insert', {
        hostId: host.id,
        error,
      });
      await this.db.delete(proxyHosts).where(eq(proxyHosts.id, host.id));
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to apply Nginx config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    // 5. Audit log
    await this.auditService.log({
      userId,
      action: 'proxy_host.create',
      resourceType: 'proxy_host',
      resourceId: host.id,
      details: { type: host.type, domainNames: host.domainNames, ...rawConfigAuditDetails(input, options) },
    });

    logger.info('Created proxy host', { hostId: host.id, domains: host.domainNames });
    this.emitHost(host.id, 'created', host.domainNames?.[0]);

    // 6. Fire-and-forget immediate health check
    if (host.healthCheckEnabled) {
      this.runImmediateHealthCheck(host.id);
    }

    // 7. Return created host
    return (await attachDockerUpstreamDisplay(this.db, [host]))[0]!;
  }

  // -----------------------------------------------------------------------
  // Update
  // -----------------------------------------------------------------------

  async updateProxyHost(
    id: string,
    input: UpdateProxyHostInput,
    userId: string,
    validationOptions: ProxyValidationInput = {}
  ) {
    const options = normalizeProxyValidationOptions(validationOptions);

    // 0. Validate advanced config if provided
    if (input.advancedConfig && !options.bypassAdvancedValidation) {
      const validation = this.configGenerator.validateAdvancedConfig(input.advancedConfig);
      if (!validation.valid) {
        throw new AppError(
          400,
          'INVALID_ADVANCED_CONFIG',
          `Advanced config is invalid: ${validation.errors.join(', ')}`
        );
      }
    }
    if ((input as any).rawConfig) {
      const validation = this.configGenerator.validateAdvancedConfig(
        (input as any).rawConfig,
        true,
        options.bypassRawValidation === true
      );
      if (!validation.valid) {
        throw new AppError(400, 'INVALID_RAW_CONFIG', `Raw config is invalid: ${validation.errors.join(', ')}`);
      }
    }

    // 1. Get existing host
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
    });
    if (!existing) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (existing.isSystem) throw new AppError(403, 'SYSTEM_HOST', 'System proxy hosts cannot be edited');
    if (
      existing.maintenanceEnabled &&
      ((input.type !== undefined && input.type !== 'proxy') || input.rawConfigEnabled === true)
    ) {
      throw new AppError(
        409,
        'MAINTENANCE_MODE_CONFLICT',
        'Exit maintenance mode before changing the host type or enabling raw config'
      );
    }

    const storedRawConfig = storedRawConfigForRawModeEnablement(existing, input);
    if (storedRawConfig) {
      const validation = this.configGenerator.validateAdvancedConfig(
        storedRawConfig as string,
        true,
        options.bypassRawValidation === true
      );
      if (!validation.valid) {
        throw new AppError(400, 'INVALID_RAW_CONFIG', `Raw config is invalid: ${validation.errors.join(', ')}`);
      }
    }

    if (input.nodeId && input.nodeId !== existing.nodeId) {
      await assertNodeAllowsServiceCreation(this.db, input.nodeId, 'nginx');
    }

    assertSslPrerequisitesForUpdate(existing, input);

    const upstreamData = await this.prepareUpdateUpstream(existing, input, options);

    // 2. Update DB
    const updateData: Record<string, unknown> = {
      ...input,
      ...upstreamData,
      updatedAt: new Date(),
    };

    // Raw mode bypasses managed upstream settings, so managed health checks are not meaningful.
    const enablesRawMode = input.rawConfigEnabled === true || input.type === 'raw';
    if (enablesRawMode) {
      updateData.healthCheckEnabled = false;
      updateData.healthStatus = 'disabled';
    }

    // Update healthStatus when healthCheckEnabled changes
    if (!enablesRawMode && input.healthCheckEnabled !== undefined) {
      if (!input.healthCheckEnabled) {
        updateData.healthStatus = 'disabled';
      } else if (!existing.healthCheckEnabled) {
        // Was disabled, now enabled — set to unknown until first check
        updateData.healthStatus = 'unknown';
      }
    }

    const updateHost = async (slug?: string) => {
      const [updated] = await this.db
        .update(proxyHosts)
        .set({ ...updateData, ...(slug === undefined ? {} : { slug }) })
        .where(eq(proxyHosts.id, id))
        .returning();
      return updated;
    };
    const primaryDomainChanged = input.domainNames !== undefined && input.domainNames[0] !== existing.domainNames[0];
    const updated = primaryDomainChanged
      ? await writeWithAllocatedSlug({
          source: input.domainNames?.[0] ?? '',
          fallback: 'proxy-host',
          reserved: ['new'],
          constraint: 'proxy_hosts_slug_unique',
          write: updateHost,
        })
      : await updateHost();

    // 3. Regenerate nginx config
    try {
      const certPaths = await this.resolveCertPaths(updated);
      const accessList = await this.resolveAccessList(updated.accessListId);
      const config = await this.buildNginxConfig(updated, certPaths, accessList);

      if (updated.enabled) {
        // 4. Apply config with rollback on failure
        await this.applyConfigToNode(id, config, updated.nodeId);
      } else {
        // If disabled, remove config and reload
        await this.removeConfigFromNode(id, updated.nodeId);
      }
    } catch (error) {
      // Roll back every field changed by the request or by upstream resolution.
      logger.error('Failed to apply nginx config during update, rolling back DB', {
        hostId: id,
        error,
      });
      const rollbackData: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(input), ...Object.keys(upstreamData)])) {
        rollbackData[key] = (existing as Record<string, unknown>)[key];
      }
      if (primaryDomainChanged) rollbackData.slug = existing.slug;
      rollbackData.updatedAt = existing.updatedAt;
      try {
        await this.db.update(proxyHosts).set(rollbackData).where(eq(proxyHosts.id, id));
      } catch (rollbackError) {
        logger.error('Failed to rollback DB after nginx config failure', {
          hostId: id,
          rollbackError,
        });
      }
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to apply Nginx config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    // 5. Audit log
    await this.auditService.log({
      userId,
      action: 'proxy_host.update',
      resourceType: 'proxy_host',
      resourceId: id,
      details: { changes: Object.keys(input), ...rawConfigAuditDetails(input, options) },
    });

    logger.info('Updated proxy host', { hostId: id });
    this.emitHost(
      id,
      'updated',
      updated.domainNames?.[0],
      updated.slug === existing.slug ? {} : { oldSlug: existing.slug, slug: updated.slug }
    );

    // Fire immediate health check if healthcheck was just enabled
    if (input.healthCheckEnabled && !existing.healthCheckEnabled && updated.enabled) {
      this.runImmediateHealthCheck(id);
    }

    return (await attachDockerUpstreamDisplay(this.db, [updated]))[0]!;
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  async deleteProxyHost(id: string, userId: string) {
    // 1. Get existing host
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
    });
    if (!existing) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (existing.isSystem) throw new AppError(403, 'SYSTEM_HOST', 'System proxy hosts cannot be deleted');

    // 2. Delete from DB first (safer — lingering config is less harmful than zombie DB record)
    await this.db.delete(proxyHosts).where(eq(proxyHosts.id, id));

    // 3. Remove nginx config and reload (non-fatal if it fails after DB delete)
    try {
      await this.removeConfigFromNode(id, existing.nodeId);
    } catch (err) {
      logger.warn('Failed to remove nginx config after DB delete', { hostId: id, error: (err as Error).message });
    }

    // 5. Audit log
    await this.auditService.log({
      userId,
      action: 'proxy_host.delete',
      resourceType: 'proxy_host',
      resourceId: id,
      details: { domainNames: existing.domainNames },
    });

    logger.info('Deleted proxy host', { hostId: id, domains: existing.domainNames });
    this.emitHost(id, 'deleted', existing.domainNames?.[0]);
    this.reconcileMaintenanceAlerts(id);
  }

  // -----------------------------------------------------------------------
  // Get single
  // -----------------------------------------------------------------------

  async getProxyHost(id: string) {
    const host = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
    });
    if (!host) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (host.isSystem) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');

    // Resolve relations
    const sslCert = host.sslCertificateId
      ? await this.db.query.sslCertificates.findFirst({
          where: eq(sslCertificates.id, host.sslCertificateId),
        })
      : null;

    const internalCert = host.internalCertificateId
      ? await this.db.query.certificates.findFirst({
          where: eq(certificates.id, host.internalCertificateId),
        })
      : null;

    const accessList = host.accessListId
      ? await this.db.query.accessLists.findFirst({
          where: eq(accessLists.id, host.accessListId),
        })
      : null;

    const [displayHost] = await attachDockerUpstreamDisplay(this.db, [host]);
    return {
      ...stripProxyHealthHistory(displayHost!),
      sslCertificate: sslCert
        ? {
            id: sslCert.id,
            name: sslCert.name,
            type: sslCert.type,
            domainNames: sslCert.domainNames,
            status: sslCert.status,
            notAfter: sslCert.notAfter,
          }
        : null,
      internalCertificate: internalCert
        ? {
            id: internalCert.id,
            commonName: internalCert.commonName,
            status: internalCert.status,
            notAfter: internalCert.notAfter,
          }
        : null,
      accessList: accessList
        ? {
            id: accessList.id,
            name: accessList.name,
          }
        : null,
    };
  }

  async getProxyHostBySlug(slug: string) {
    const host = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.slug, slug),
      columns: { id: true, isSystem: true },
    });
    if (!host || host.isSystem) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    return this.getProxyHost(host.id);
  }

  async getProxyHostHealthHistory(id: string) {
    const host = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
      columns: { id: true, isSystem: true, healthHistory: true },
    });
    if (!host) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (host.isSystem) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    return host.healthHistory ?? [];
  }

  // -----------------------------------------------------------------------
  // List
  // -----------------------------------------------------------------------

  async listProxyHosts(
    query: ProxyHostListQuery,
    options?: { allowedIds?: string[] }
  ): Promise<PaginatedResponse<ProxyHostView>> {
    const conditions = [eq(proxyHosts.isSystem, false)];

    if (options?.allowedIds) {
      if (options.allowedIds.length === 0) {
        return {
          data: [],
          pagination: { page: query.page, limit: query.limit, total: 0, totalPages: 0 },
        };
      }
      conditions.push(inArray(proxyHosts.id, options.allowedIds));
    }

    if (query.type) {
      conditions.push(eq(proxyHosts.type, query.type));
    }
    if (query.enabled !== undefined) {
      conditions.push(eq(proxyHosts.enabled, query.enabled));
    }
    if (query.healthStatus) {
      conditions.push(
        query.healthStatus === 'disabled'
          ? or(eq(proxyHosts.healthStatus, 'disabled'), eq(proxyHosts.rawConfigEnabled, true))!
          : and(eq(proxyHosts.healthStatus, query.healthStatus), eq(proxyHosts.rawConfigEnabled, false))!
      );
    }
    if (query.search) {
      // Search across domain names (cast jsonb to text for ilike)
      conditions.push(ilike(sql`${proxyHosts.domainNames}::text`, `%${escapeLike(query.search)}%`));
    }
    if (query.nodeId) {
      conditions.push(eq(proxyHosts.nodeId, query.nodeId));
    }

    const where = buildWhere(conditions);

    const [entries, [{ count: totalCount }]] = await Promise.all([
      this.db.query.proxyHosts.findMany({
        where: where ? () => where : undefined,
        orderBy: [desc(proxyHosts.createdAt)],
        limit: query.limit,
        offset: (query.page - 1) * query.limit,
      }),
      this.db.select({ count: count() }).from(proxyHosts).where(where),
    ]);

    const total = Number(totalCount);

    const displayEntries = await attachDockerUpstreamDisplay(this.db, entries);
    return {
      data: displayEntries.map(({ healthHistory, rawConfig: _rc, ...rest }) => {
        let effectiveStatus = rest.rawConfigEnabled ? 'disabled' : (rest.healthStatus as string);
        if (
          !rest.rawConfigEnabled &&
          rest.healthStatus === 'online' &&
          Array.isArray(healthHistory) &&
          healthHistory.length > 0
        ) {
          const fiveMinAgo = Date.now() - 5 * 60 * 1000;
          const recent = (healthHistory as Array<{ ts?: string; status: string }>).filter((h) => {
            if (!h.ts) return false;
            return new Date(h.ts).getTime() >= fiveMinAgo;
          });
          if (recent.some((h) => h.status === 'offline' || h.status === 'degraded')) {
            effectiveStatus = 'recovering';
          }
        }
        return { ...rest, effectiveHealthStatus: effectiveStatus };
      }) as any,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  // -----------------------------------------------------------------------
  // Toggle enabled/disabled
  // -----------------------------------------------------------------------

  async toggleProxyHost(id: string, enabled: boolean, userId: string) {
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
    });
    if (!existing) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (existing.isSystem) throw new AppError(403, 'SYSTEM_HOST', 'System proxy hosts cannot be toggled');
    if (existing.enabled === enabled) return (await attachDockerUpstreamDisplay(this.db, [existing]))[0]!;

    const previousEnabled = existing.enabled;
    const exitsMaintenance = !enabled && existing.maintenanceEnabled;

    const [updated] = await this.db
      .update(proxyHosts)
      .set({
        enabled,
        ...(exitsMaintenance
          ? {
              maintenanceEnabled: false,
              maintenanceStartedAt: null,
              healthStatus: existing.healthCheckEnabled ? ('unknown' as const) : existing.healthStatus,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(proxyHosts.id, id))
      .returning();

    try {
      if (enabled) {
        // Re-enable: generate config and apply
        const certPaths = await this.resolveCertPaths(updated);
        const accessList = await this.resolveAccessList(updated.accessListId);
        const config = await this.buildNginxConfig(updated, certPaths, accessList);
        await this.applyConfigToNode(id, config, updated.nodeId);
      } else {
        // Disable: remove config and reload
        await this.removeConfigFromNode(id, updated.nodeId);
      }
    } catch (error) {
      // Rollback DB to previous enabled state
      logger.error('Failed to apply nginx config during toggle, rolling back DB', {
        hostId: id,
        error,
      });
      await this.db
        .update(proxyHosts)
        .set({
          enabled: previousEnabled,
          maintenanceEnabled: existing.maintenanceEnabled,
          maintenanceStartedAt: existing.maintenanceStartedAt,
          healthStatus: existing.healthStatus,
          updatedAt: existing.updatedAt,
        })
        .where(eq(proxyHosts.id, id));
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to apply Nginx config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    await this.auditService.log({
      userId,
      action: enabled ? 'proxy_host.enable' : 'proxy_host.disable',
      resourceType: 'proxy_host',
      resourceId: id,
    });

    logger.info('Toggled proxy host', { hostId: id, enabled });
    this.emitHost(id, 'updated', existing.domainNames?.[0]);
    if (exitsMaintenance) this.reconcileMaintenanceAlerts(id);

    // Fire-and-forget immediate health check when enabling
    if (enabled && updated.healthCheckEnabled) {
      this.runImmediateHealthCheck(id);
    }

    return (await attachDockerUpstreamDisplay(this.db, [updated]))[0]!;
  }

  async toggleMaintenance(id: string, enabled: boolean, userId: string) {
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
    });
    if (!existing) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (existing.isSystem) throw new AppError(403, 'SYSTEM_HOST', 'System proxy hosts cannot enter maintenance');
    if (existing.maintenanceEnabled === enabled) {
      return (await attachDockerUpstreamDisplay(this.db, [existing]))[0]!;
    }
    if (enabled) {
      if (!existing.enabled) {
        throw new AppError(409, 'MAINTENANCE_HOST_DISABLED', 'Enable the proxy host before entering maintenance');
      }
      if (existing.type !== 'proxy' || existing.rawConfigEnabled) {
        throw new AppError(
          409,
          'MAINTENANCE_UNSUPPORTED_HOST',
          'Maintenance is available only for managed proxy hosts without raw mode'
        );
      }
    }

    const [updated] = await this.db
      .update(proxyHosts)
      .set({
        maintenanceEnabled: enabled,
        maintenanceStartedAt: enabled ? new Date() : null,
        ...(!enabled && existing.healthCheckEnabled ? { healthStatus: 'unknown' as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(proxyHosts.id, id))
      .returning();

    try {
      if (updated.enabled) {
        const certPaths = await this.resolveCertPaths(updated);
        const accessList = await this.resolveAccessList(updated.accessListId);
        const config = await this.buildNginxConfig(updated, certPaths, accessList);
        await this.applyConfigToNode(id, config, updated.nodeId);
      }
    } catch (error) {
      logger.error('Failed to apply nginx config during maintenance transition, rolling back DB', {
        hostId: id,
        enabled,
        error,
      });
      await this.db
        .update(proxyHosts)
        .set({
          maintenanceEnabled: existing.maintenanceEnabled,
          maintenanceStartedAt: existing.maintenanceStartedAt,
          healthStatus: existing.healthStatus,
          updatedAt: existing.updatedAt,
        })
        .where(eq(proxyHosts.id, id));
      try {
        await this.restoreConfigOnNode(existing);
      } catch (rollbackError) {
        logger.error('Failed to restore nginx config after maintenance transition failure', {
          hostId: id,
          rollbackError,
        });
      }
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to apply Nginx config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    await this.auditService.log({
      userId,
      action: enabled ? 'proxy_host.maintenance_enter' : 'proxy_host.maintenance_exit',
      resourceType: 'proxy_host',
      resourceId: id,
      details: { domainNames: existing.domainNames },
    });
    logger.info('Toggled proxy host maintenance', { hostId: id, enabled });
    this.emitHost(id, 'updated', existing.domainNames?.[0], { maintenanceEnabled: enabled });
    this.reconcileMaintenanceAlerts(id);

    if (!enabled && updated.healthCheckEnabled) this.runImmediateHealthCheck(id);
    return (await attachDockerUpstreamDisplay(this.db, [updated]))[0]!;
  }

  // -----------------------------------------------------------------------
  // Immediate single-host health check (fire-and-forget)
  // -----------------------------------------------------------------------

  private runImmediateHealthCheck(hostId: string): void {
    runImmediateProxyHealthCheck({ db: this.db, hostId, logger });
  }

  private queueDockerReconciliation(): void {
    if (!this.dockerUpstreams) return;
    this.dockerReconcileDirty = true;
    if (this.dockerReconcileRunning) return;
    this.dockerReconcileRunning = true;
    void (async () => {
      try {
        do {
          this.dockerReconcileDirty = false;
          await this.reconcileDockerUpstreams();
        } while (this.dockerReconcileDirty);
      } catch (error) {
        logger.error('Docker proxy upstream reconciliation failed', { error });
      } finally {
        this.dockerReconcileRunning = false;
        if (this.dockerReconcileDirty) this.queueDockerReconciliation();
      }
    })();
  }

  private async updateRenamedContainerReferences(nodeId: string, oldName: string, newName: string): Promise<void> {
    const updated = await this.db
      .update(proxyHosts)
      .set({ dockerContainerName: newName, updatedAt: new Date() })
      .where(
        and(
          eq(proxyHosts.upstreamKind, 'docker_container'),
          eq(proxyHosts.dockerNodeId, nodeId),
          eq(proxyHosts.dockerContainerName, oldName)
        )
      )
      .returning();
    for (const host of updated) this.emitHost(host.id, 'updated', host.domainNames?.[0]);
    this.queueDockerReconciliation();
  }

  private async resolveStoredDockerUpstream(host: ProxyHostRow): Promise<ProxyHostRow> {
    if (host.upstreamKind === 'manual' || !this.dockerUpstreams) return host;
    const resolved = await this.dockerUpstreams.resolve(host, { allowPortRebind: true });
    const changed =
      host.forwardHost !== resolved.forwardHost ||
      host.forwardPort !== resolved.forwardPort ||
      host.dockerHostPort !== resolved.dockerHostPort ||
      host.dockerContainerPort !== resolved.dockerContainerPort ||
      host.dockerNodeId !== resolved.dockerNodeId ||
      host.dockerContainerName !== resolved.dockerContainerName ||
      host.dockerDeploymentId !== resolved.dockerDeploymentId;
    if (!changed) return host;
    const [updated] = await this.db
      .update(proxyHosts)
      .set({ ...resolved, updatedAt: new Date() })
      .where(eq(proxyHosts.id, host.id))
      .returning();
    return updated ?? host;
  }

  private async reconcileDockerUpstreams(): Promise<void> {
    const hosts = await this.db.query.proxyHosts.findMany({
      where: and(eq(proxyHosts.type, 'proxy'), ne(proxyHosts.upstreamKind, 'manual')),
    });
    for (const host of hosts) {
      try {
        const updated = await this.resolveStoredDockerUpstream(host);
        if (updated === host) continue;
        if (updated.enabled) {
          try {
            const certPaths = await this.resolveCertPaths(updated);
            const accessList = await this.resolveAccessList(updated.accessListId);
            const config = await this.buildNginxConfig(updated, certPaths, accessList);
            await this.applyConfigToNode(updated.id, config, updated.nodeId);
          } catch (error) {
            // Keep the newly resolved endpoint. A disconnected Nginx node will
            // receive it through the existing resync path after reconnecting.
            logger.warn('Resolved Docker upstream but could not apply Nginx config yet', {
              hostId: updated.id,
              error,
            });
          }
        }
        this.emitHost(updated.id, 'updated', updated.domainNames?.[0]);
      } catch (error) {
        // External disappearance/offline state intentionally keeps the last
        // resolved endpoint and the existing Nginx configuration intact.
        logger.debug('Keeping last resolved Docker proxy upstream', { hostId: host.id, error });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Resync all hosts on a node (used on reconnect with hash mismatch)
  // -----------------------------------------------------------------------

  async resyncAllHostsOnNode(nodeId: string): Promise<void> {
    // Only resync enabled hosts explicitly assigned to this node
    const hosts = await this.db.query.proxyHosts.findMany({
      where: and(eq(proxyHosts.nodeId, nodeId), eq(proxyHosts.enabled, true)),
    });

    if (hosts.length === 0) {
      logger.info('No enabled hosts to resync for node', { nodeId });
      return;
    }

    logger.info('Resyncing all hosts on node', { nodeId, hostCount: hosts.length });

    for (const storedHost of hosts) {
      try {
        const host = await this.resolveStoredDockerUpstream(storedHost).catch(() => storedHost);
        const certPaths = await this.resolveCertPaths(host);
        const accessList = await this.resolveAccessList(host.accessListId);
        const config = await this.buildNginxConfig(host, certPaths, accessList);
        await this.applyConfigToNode(host.id, config, host.nodeId ?? nodeId);
      } catch (err) {
        logger.error('Failed to resync host config', {
          hostId: storedHost.id,
          nodeId,
          error: (err as Error).message,
        });
      }
    }

    logger.info('Node resync complete', { nodeId, hostCount: hosts.length });
  }

  // -----------------------------------------------------------------------
  // Get rendered nginx config for a host
  // -----------------------------------------------------------------------

  async getRenderedConfig(id: string): Promise<string> {
    const host = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
    });
    if (!host) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (host.isSystem) throw new AppError(403, 'SYSTEM_HOST', 'System proxy host config cannot be rendered here');

    const certPaths = await this.resolveCertPaths(host);
    const accessList = await this.resolveAccessList(host.accessListId);
    return this.buildNginxConfig(host, certPaths, accessList);
  }

  // -----------------------------------------------------------------------
  // Internal system host management
  // -----------------------------------------------------------------------

  async upsertStatusPageSystemHost(input: StatusPageSystemHostInput, userId: string): Promise<ProxyHostRow> {
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.systemKind, 'status_page'),
    });
    if (!existing || existing.nodeId !== input.nodeId) {
      await assertNodeAllowsServiceCreation(this.db, input.nodeId, 'nginx');
    }
    const sslEnabled = !!input.sslCertificateId;
    const upstream = getStatusPageUpstream(input.upstreamUrl);
    const data = {
      type: 'proxy' as const,
      domainNames: [input.domain],
      enabled: true,
      forwardHost: upstream.host,
      forwardPort: upstream.port,
      forwardScheme: upstream.scheme,
      sslEnabled,
      sslForced: sslEnabled,
      http2Support: true,
      websocketSupport: false,
      sslCertificateId: input.sslCertificateId ?? null,
      internalCertificateId: null,
      redirectUrl: null,
      redirectStatusCode: 301,
      customHeaders: [],
      cacheEnabled: false,
      cacheOptions: null,
      rateLimitEnabled: false,
      rateLimitOptions: null,
      customRewrites: [],
      advancedConfig: null,
      rawConfig: null,
      rawConfigEnabled: false,
      accessListId: null,
      folderId: null,
      nginxTemplateId: input.nginxTemplateId ?? null,
      templateVariables: {},
      nodeId: input.nodeId,
      healthCheckEnabled: false,
      healthCheckUrl: '/',
      healthCheckInterval: 30,
      healthCheckExpectedStatus: null,
      healthCheckExpectedBody: null,
      healthCheckBodyMatchMode: 'includes' as const,
      healthCheckSlowThreshold: 3,
      healthStatus: 'disabled' as const,
      isSystem: true,
      systemKind: 'status_page',
      updatedAt: new Date(),
    };

    const createdNew = !existing;
    const writeHost = async (slug?: string) => {
      const [host] = existing
        ? await this.db
            .update(proxyHosts)
            .set({ ...data, ...(slug === undefined ? {} : { slug }) })
            .where(eq(proxyHosts.id, existing.id))
            .returning()
        : await this.db
            .insert(proxyHosts)
            .values({
              ...data,
              slug: slug!,
              createdById: userId,
            })
            .returning();
      return host;
    };
    const primaryDomainChanged = !existing || existing.domainNames[0] !== input.domain;
    const host = primaryDomainChanged
      ? await writeWithAllocatedSlug({
          source: input.domain,
          fallback: 'proxy-host',
          reserved: ['new'],
          constraint: 'proxy_hosts_slug_unique',
          write: writeHost,
        })
      : await writeHost();

    try {
      const certPaths = await this.resolveCertPaths(host);
      const config = await this.buildNginxConfig(host, certPaths, null);
      await this.applyConfigToNode(host.id, config, host.nodeId);
    } catch (error) {
      logger.error('Failed to apply status page system proxy host config', {
        hostId: host.id,
        error,
      });
      if (createdNew) {
        await this.db.delete(proxyHosts).where(eq(proxyHosts.id, host.id));
      } else if (existing) {
        await this.db
          .update(proxyHosts)
          .set({ ...buildStatusPageSystemHostRollbackData(existing), slug: existing.slug } as any)
          .where(eq(proxyHosts.id, existing.id));
      }
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to apply status page proxy config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    await this.auditService.log({
      userId,
      action: existing ? 'proxy_host.system_update' : 'proxy_host.system_create',
      resourceType: 'proxy_host',
      resourceId: host.id,
      details: { systemKind: 'status_page', domain: input.domain, nodeId: input.nodeId },
    });
    this.emitHost(host.id, 'updated', input.domain);
    return host;
  }

  async disableStatusPageSystemHost(userId: string): Promise<ProxyHostRow | null> {
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.systemKind, 'status_page'),
    });
    if (!existing) return null;

    try {
      await this.removeConfigFromNode(existing.id, existing.nodeId);
      await this.db.delete(proxyHosts).where(eq(proxyHosts.id, existing.id));
    } catch (error) {
      logger.error('Failed to remove status page system proxy host config', {
        hostId: existing.id,
        error,
      });
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to disable status page proxy config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    await this.auditService.log({
      userId,
      action: 'proxy_host.system_disable',
      resourceType: 'proxy_host',
      resourceId: existing.id,
      details: { systemKind: 'status_page' },
    });
    this.emitHost(existing.id, 'deleted', existing.domainNames?.[0]);
    return existing;
  }

  // -----------------------------------------------------------------------
  // Validate advanced config snippet
  // -----------------------------------------------------------------------

  async validateAdvancedConfig(
    snippet: string,
    rawMode = false,
    bypassAdvancedValidation = false,
    bypassRawValidation = false
  ) {
    if (!rawMode && bypassAdvancedValidation) {
      return { valid: true, errors: [] };
    }

    // Basic static checks first
    const staticResult = this.configGenerator.validateAdvancedConfig(snippet, rawMode, bypassRawValidation);
    if (!staticResult.valid) return staticResult;

    // Do not run backend-local nginx -t for raw mode. Raw configs can contain
    // valid node-specific includes/paths that do not exist inside the Gateway
    // container, so local syntax checks produce false failures. The actual
    // node-side validation still happens during save/apply.
    if (rawMode) {
      return staticResult;
    }

    try {
      this.nginxTemplateService.previewWithSampleData(snippet);
    } catch (err) {
      return {
        valid: false,
        errors: [err instanceof Error ? `Template rendering error: ${err.message}` : 'Template rendering error'],
      };
    }

    return staticResult;
  }

  // -----------------------------------------------------------------------
  // Helpers — cert path resolution
  // -----------------------------------------------------------------------

  private async resolveCertPaths(host: ProxyHostRow): Promise<CertPaths> {
    const empty: CertPaths = { sslCertPath: null, sslKeyPath: null, sslChainPath: null };

    if (!host.sslEnabled) return empty;

    // SSL certificate from the ssl_certificates table (ACME / upload)
    if (host.sslCertificateId) {
      const sslCert = await this.db.query.sslCertificates.findFirst({
        where: eq(sslCertificates.id, host.sslCertificateId),
      });

      if (sslCert?.certificatePem && sslCert.privateKeyPem) {
        // Decrypt the private key
        let keyPem: string;
        if (sslCert.encryptedDek) {
          keyPem = this.cryptoService.decryptPrivateKey({
            encryptedPrivateKey: sslCert.privateKeyPem,
            encryptedDek: sslCert.encryptedDek,
            dekIv: sslCert.dekIv || '',
          });
        } else {
          keyPem = sslCert.privateKeyPem;
        }

        if (!keyPem.includes('-----BEGIN')) {
          logger.error('SSL key decryption produced invalid PEM', {
            certId: sslCert.id,
            starts: keyPem.substring(0, 20),
          });
          throw new Error('Failed to decrypt SSL certificate private key');
        }

        // Deploy cert to the node via daemon
        const resolvedNodeId = await this.nodeDispatch.resolveNodeId(host.nodeId);
        await this.nodeDispatch.deployCertificate(
          resolvedNodeId,
          sslCert.id,
          Buffer.from(sslCert.certificatePem),
          Buffer.from(keyPem),
          sslCert.chainPem ? Buffer.from(sslCert.chainPem) : undefined
        );

        await this.auditService.log({
          userId: null,
          action: 'node.cert_deploy',
          resourceType: 'ssl_certificate',
          resourceId: sslCert.id,
          details: { nodeId: resolvedNodeId },
        });

        const paths = this.configGenerator.getCertPaths(sslCert.id);
        return {
          sslCertPath: paths.certPath,
          sslKeyPath: paths.keyPath,
          sslChainPath: sslCert.chainPem ? paths.chainPath : null,
        };
      }

      // Older/imported certificate rows may not retain decryptable PEM data even
      // though the certificate is already deployed on the Nginx node. Keep the
      // stable daemon paths so config-only transitions do not silently drop TLS.
      const paths = this.configGenerator.getCertPaths(host.sslCertificateId);
      return {
        sslCertPath: paths.certPath,
        sslKeyPath: paths.keyPath,
        sslChainPath: sslCert?.chainPem ? paths.chainPath : null,
      };
    }

    // Internal certificate from PKI certificates table
    if (host.internalCertificateId) {
      const cert = await this.db.query.certificates.findFirst({
        where: eq(certificates.id, host.internalCertificateId),
      });

      if (cert?.certificatePem && cert.encryptedPrivateKey && cert.encryptedDek && cert.dekIv) {
        const keyPem = this.cryptoService.decryptPrivateKey({
          encryptedPrivateKey: cert.encryptedPrivateKey,
          encryptedDek: cert.encryptedDek,
          dekIv: cert.dekIv,
        });

        const certId = `internal-${cert.id}`;
        const resolvedNodeId = await this.nodeDispatch.resolveNodeId(host.nodeId);
        await this.nodeDispatch.deployCertificate(
          resolvedNodeId,
          certId,
          Buffer.from(cert.certificatePem),
          Buffer.from(keyPem)
        );

        await this.auditService.log({
          userId: null,
          action: 'node.cert_deploy',
          resourceType: 'certificate',
          resourceId: cert.id,
          details: { nodeId: resolvedNodeId, internal: true },
        });

        const paths = this.configGenerator.getCertPaths(certId);
        return {
          sslCertPath: paths.certPath,
          sslKeyPath: paths.keyPath,
          sslChainPath: null,
        };
      }

      const paths = this.configGenerator.getCertPaths(`internal-${host.internalCertificateId}`);
      return {
        sslCertPath: paths.certPath,
        sslKeyPath: paths.keyPath,
        sslChainPath: null,
      };
    }

    return empty;
  }

  // -----------------------------------------------------------------------
  // Helpers — access list resolution
  // -----------------------------------------------------------------------

  private async resolveAccessList(accessListId: string | null): Promise<ProxyHostConfig['accessList']> {
    if (!accessListId) return null;

    const list = await this.db.query.accessLists.findFirst({
      where: eq(accessLists.id, accessListId),
    });

    if (!list) return null;

    return {
      id: list.id,
      ipRules: list.ipRules as { type: string; value: string }[],
      basicAuthEnabled: list.basicAuthEnabled,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers — build ProxyHostConfig from DB row
  // -----------------------------------------------------------------------

  private async buildNginxConfig(
    host: ProxyHostRow,
    certPaths: CertPaths,
    accessList: ProxyHostConfig['accessList']
  ): Promise<string> {
    const config: ProxyHostConfig = {
      id: host.id,
      type: host.type,
      domainNames: host.domainNames,
      enabled: host.enabled,
      forwardHost: host.forwardHost,
      forwardPort: host.forwardPort,
      forwardScheme: host.forwardScheme ?? 'http',
      sslEnabled: host.sslEnabled && !!certPaths.sslCertPath && !!certPaths.sslKeyPath,
      sslForced: host.sslForced,
      http2Support: host.http2Support,
      websocketSupport: host.websocketSupport,
      redirectUrl: host.redirectUrl,
      redirectStatusCode: host.redirectStatusCode ?? 301,
      customHeaders: (host.customHeaders ?? []) as { name: string; value: string }[],
      cacheEnabled: host.cacheEnabled,
      cacheOptions: host.cacheOptions as Record<string, unknown> | null,
      rateLimitEnabled: host.rateLimitEnabled,
      rateLimitOptions: host.rateLimitOptions as Record<string, unknown> | null,
      customRewrites: (host.customRewrites ?? []) as { source: string; destination: string; type: string }[],
      advancedConfig: host.advancedConfig,
      accessList,
      sslCertPath: certPaths.sslCertPath,
      sslKeyPath: certPaths.sslKeyPath,
      sslChainPath: certPaths.sslChainPath,
      templateVariables: (host.templateVariables ?? {}) as Record<string, string | number | boolean>,
    };

    // Raw config mode — bypass template rendering entirely
    if (host.rawConfigEnabled && host.rawConfig) return host.rawConfig;

    const rendered = await this.nginxTemplateService.renderForHost(config, host.nginxTemplateId ?? null);
    return host.maintenanceEnabled ? this.nginxTemplateService.applyMaintenanceGuard(rendered) : rendered;
  }
}
