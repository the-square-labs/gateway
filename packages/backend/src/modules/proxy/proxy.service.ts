import { and, count, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { accessLists } from '@/db/schema/access-lists.js';
import { certificates } from '@/db/schema/certificates.js';
import { nodes, proxyHosts } from '@/db/schema/index.js';
import { sslCertificates } from '@/db/schema/ssl-certificates.js';
import { createChildLogger } from '@/lib/logger.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { buildWhere, escapeLike } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import type { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type {
  NginxCertificateDistributionService,
  PreparedTlsCertificate,
} from '@/services/nginx-certificate-distribution.service.js';
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
import type { ProxySecureLinkService } from './proxy-secure-link.service.js';
import { attachDockerUpstreamDisplay, type WithDockerUpstreamDisplay } from './proxy-upstream-display.js';

export { __testOnly } from './proxy.service-helpers.js';

const logger = createChildLogger('ProxyService');
const SECURE_LINK_RUNTIME_DEDUP_WINDOW_MS = 500;
const SECURE_LINK_BACKGROUND_TRAFFIC_TAIL_LINES = 200;
const SECURE_LINK_FOCUSED_TRAFFIC_TAIL_LINES = 10_000;
const SECURE_LINK_RUNTIME_CACHE_PREFIX = 'proxy-secure-link-runtime:';
const SECURE_LINK_RUNTIME_CACHE_TTL_SECONDS = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProxyHostRow = typeof proxyHosts.$inferSelect;
type ProxyHostView = WithDockerUpstreamDisplay<ProxyHostRow>;

interface ProxyHostTrafficRuntime {
  hostId: string;
  statusCodes: { s2xx: number; s3xx: number; s4xx: number; s5xx: number };
  avgResponseTime: number;
  p95ResponseTime: number;
  totalRequests: number;
  totalBytes: number;
  requestsPerSecond: number;
  bytesPerSecond: number;
  busiestClientRps: number;
  windowSeconds: number;
  sampleTruncated: boolean;
  lastRequestAt?: string;
}

type ProxyRouteRuntime = Awaited<ReturnType<ProxySecureLinkService['getRuntime']>>;

interface ProxySecureLinkRuntimeSnapshot {
  timestamp: string;
  runtime: ProxyRouteRuntime | null;
  traffic: ProxyHostTrafficRuntime | null;
}

interface ProxySecureLinkRuntimeSample {
  snapshot: ProxySecureLinkRuntimeSnapshot;
  history: ProxySecureLinkRuntimeSnapshot[];
}

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
    private readonly configGenerator: NginxConfigGenerator,
    private readonly nodeDispatch: NodeDispatchService,
    private readonly certificateDistribution: NginxCertificateDistributionService,
    private readonly dockerUpstreams?: ProxyDockerUpstreamService,
    private readonly secureLinks?: ProxySecureLinkService,
    private readonly cache?: CacheService
  ) {}

  private eventBus?: EventBusService;
  private notificationEvaluator?: NotificationEvaluatorService;
  private dockerReconcileRunning = false;
  private dockerReconcileDirty = false;
  private dockerReconcileForce = false;
  private dockerReconcileRetry?: ReturnType<typeof setTimeout>;
  private dockerReconcileBackoffMs = 5_000;
  private readonly secureLinkRuntimeHistory = new Map<string, ProxySecureLinkRuntimeSnapshot[]>();
  private readonly secureLinkRuntimeSamplesInFlight = new Map<string, Promise<ProxySecureLinkRuntimeSample>>();
  private secureLinkRuntimeBackgroundInFlight: Promise<void> | null = null;
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
    bus.subscribe('docker.snapshot.changed', (payload) => {
      if ((payload as { kind?: string })?.kind === 'containers') this.queueDockerReconciliation();
    });
    bus.subscribe('docker.deployment.changed', () => this.queueDockerReconciliation());
    bus.subscribe('node.service_address.changed', () => this.queueDockerReconciliation(true));
    bus.subscribe('node.changed', () => this.queueDockerReconciliation(true));
    bus.subscribe('docker.container.changed', (payload) => {
      const event = payload as { action?: string; nodeId?: string; name?: string; oldName?: string };
      if (event.action === 'renamed' && event.nodeId && event.name && event.oldName) {
        void this.updateRenamedContainerReferences(event.nodeId, event.oldName, event.name).catch((error) => {
          logger.error('Failed to update proxy references after container rename', { error });
        });
      }
    });
    this.queueDockerReconciliation(true);
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

  private async applyConfigToNode(
    hostId: string,
    config: string,
    nodeId: string | null,
    preparedTls?: PreparedTlsCertificate | null,
    configOwnership = 'user_owned'
  ): Promise<void> {
    const resolvedNodeId = preparedTls?.nodeId ?? (await this.nodeDispatch.resolveNodeId(nodeId));
    if (preparedTls) {
      await this.certificateDistribution.applyHostBundle({ id: hostId, nodeId }, config, preparedTls, configOwnership);
    } else {
      const result = await this.nodeDispatch.applyConfig(resolvedNodeId, hostId, config, false, configOwnership);
      if (!result.success) {
        throw new Error(result.error || 'Daemon config apply failed');
      }
    }
    await this.auditService.log({
      userId: null,
      action: 'node.config_push',
      resourceType: 'proxy_host',
      resourceId: hostId,
      details: { nodeId: resolvedNodeId },
    });
  }

  private configOwnershipForHost(host: ProxyHostRow): 'managed_secure_link' | 'user_owned' {
    const committedSecureConfig =
      host.secureLinkMigratedAt != null &&
      (host.secureLinkStatus === 'active' || host.secureLinkStatus === 'cutover_ready');
    return host.type === 'proxy' && !host.rawConfigEnabled && host.upstreamKind !== 'manual' && committedSecureConfig
      ? 'managed_secure_link'
      : 'user_owned';
  }

  private async restoreConfigOnNode(host: ProxyHostRow): Promise<void> {
    const certPaths = await this.resolveCertPaths(host, { preserveLegacyOnUnsupported: true });
    const accessList = await this.resolveAccessList(host.accessListId);
    const config = await this.buildNginxConfig(host, certPaths, accessList);
    await this.applyConfigToNode(
      host.id,
      config,
      host.nodeId,
      certPaths.preparedTls,
      this.configOwnershipForHost(host)
    );
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
    const targetChanged =
      existing.upstreamKind !== effectiveKind ||
      existing.dockerNodeId !== reference.dockerNodeId ||
      existing.dockerContainerName !== reference.dockerContainerName ||
      existing.dockerDeploymentId !== reference.dockerDeploymentId ||
      existing.dockerContainerPort !== reference.dockerContainerPort ||
      (existing.dockerProtocol ?? 'tcp') !== (reference.dockerProtocol ?? 'tcp');
    if (!targetChanged) return {};
    const resolved = await this.requireDockerUpstreams().resolve(reference, {
      actorScopes: normalized.actorScopes,
      requireAvailable: true,
    });
    // Create-time Docker resolution uses loopback placeholders, but an update
    // must retain the real legacy endpoint until Secure Link cutover commits.
    const { forwardHost: _forwardHost, forwardPort: _forwardPort, ...candidate } = resolved;
    return candidate;
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
    let host = await writeWithAllocatedSlug({
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
            rateLimitMode: input.rateLimitMode,
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
      if (host.upstreamKind !== 'manual') {
        if (!this.secureLinks) throw new Error('Proxy Secure Links are unavailable');
        host = await this.secureLinks.prepare(host, true);
        await this.secureLinks.commitCutover(host.id);
        host = (await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, host.id) })) ?? host;
      }
      const certPaths = await this.resolveCertPaths(host);
      const accessList = await this.resolveAccessList(host.accessListId);
      const config = await this.buildNginxConfig(host, certPaths, accessList);

      // 3. Apply config via daemon or legacy docker
      await this.applyConfigToNode(
        host.id,
        config,
        host.nodeId,
        certPaths.preparedTls,
        this.configOwnershipForHost(host)
      );
      if (host.upstreamKind !== 'manual') await this.secureLinks?.activate(host.id);
    } catch (error) {
      // 4. If nginx fails, delete the DB row and throw
      logger.error('Failed to apply nginx config for new proxy host, rolling back DB insert', {
        hostId: host.id,
        error,
      });
      await this.secureLinks?.cleanup(host).catch((cleanupError) => {
        logger.warn('Failed to cleanup secure link after proxy create rollback', { hostId: host.id, cleanupError });
      });
      await this.db.delete(proxyHosts).where(eq(proxyHosts.id, host.id));
      if (error instanceof AppError) throw error;
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
    let updated = primaryDomainChanged
      ? await writeWithAllocatedSlug({
          source: input.domainNames?.[0] ?? '',
          fallback: 'proxy-host',
          reserved: ['new'],
          constraint: 'proxy_hosts_slug_unique',
          write: updateHost,
        })
      : await updateHost();

    // The UI can submit a complete form on an unrelated edit. Gate old
    // daemons on an actual TLS or placement change, not on field presence,
    // so existing HTTPS hosts remain editable during a mixed-fleet rollout.
    const tlsReferenceChanged =
      updated.sslEnabled !== existing.sslEnabled ||
      updated.sslCertificateId !== existing.sslCertificateId ||
      updated.internalCertificateId !== existing.internalCertificateId ||
      updated.nodeId !== existing.nodeId;
    const nodeChanged = updated.nodeId !== existing.nodeId;
    const existingUsesRawMode = existing.type === 'raw' || existing.rawConfigEnabled;
    const updatedUsesRawMode = updated.type === 'raw' || updated.rawConfigEnabled;
    const formerDockerNodeId =
      existing.upstreamKind !== 'manual' &&
      updated.upstreamKind !== 'manual' &&
      existing.dockerNodeId &&
      updated.dockerNodeId !== existing.dockerNodeId
        ? existing.dockerNodeId
        : null;
    let appliedOnTargetNode = false;

    // 3. Regenerate nginx config
    try {
      if (updated.upstreamKind !== 'manual' && !updatedUsesRawMode) {
        if (!this.secureLinks) throw new Error('Proxy Secure Links are unavailable');
        const requiresSecureLink =
          existing.upstreamKind === 'manual' ||
          existingUsesRawMode ||
          (existing.secureLinkGeneration < 1 && Object.keys(upstreamData).length > 0);
        updated = await this.secureLinks.prepare(updated, requiresSecureLink);
        if (updated.secureLinkGeneration > 0 && updated.secureLinkStatus !== 'active') {
          // Existing legacy/manual config must stop serving before the durable
          // no-fallback cutover marker is committed.
          if (existing.secureLinkGeneration === 0 && existing.enabled) {
            await this.removeConfigFromNode(id, existing.nodeId);
          }
          await this.secureLinks.commitCutover(id);
          updated = (await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, id) })) ?? updated;
        }
      }
      if (updated.enabled) {
        const certPaths = await this.resolveCertPaths(updated, {
          preserveLegacyOnUnsupported: existing.sslEnabled && !tlsReferenceChanged,
        });
        const accessList = await this.resolveAccessList(updated.accessListId);
        const config = await this.buildNginxConfig(updated, certPaths, accessList);
        // 4. Apply config with rollback on failure
        await this.applyConfigToNode(
          id,
          config,
          updated.nodeId,
          certPaths.preparedTls,
          this.configOwnershipForHost(updated)
        );
        if (updated.upstreamKind !== 'manual' && !updatedUsesRawMode) await this.secureLinks?.activate(id);
        appliedOnTargetNode = true;

        // The new target is now known-good. Only then retire the former
        // node's config and begin its certificate replica grace period.
        if (nodeChanged && existing.enabled) {
          await this.removeConfigFromNode(id, existing.nodeId);
          await this.certificateDistribution.deactivateHost(id, existing.nodeId);
        }
      } else {
        // If disabled, remove config and reload
        const deployedNodeId = nodeChanged ? existing.nodeId : updated.nodeId;
        await this.removeConfigFromNode(id, deployedNodeId);
        await this.certificateDistribution.deactivateHost(id, deployedNodeId);
      }
      const leavesManagedDocker =
        existing.upstreamKind !== 'manual' && (updated.upstreamKind === 'manual' || updatedUsesRawMode);
      if (leavesManagedDocker && existing.secureLinkGeneration > 0) {
        try {
          await this.secureLinks?.cleanup(existing);
        } catch (cleanupError) {
          // The manual/raw config is already committed. Keep it active and
          // retry the independent Secure Link teardown.
          logger.warn('Proxy left managed Docker mode; Secure Link cleanup will retry', {
            hostId: id,
            cleanupError,
          });
          this.queueDockerReconciliation();
        }
      }
      if (formerDockerNodeId) await this.secureLinks?.reconcileTargetNode(formerDockerNodeId);
    } catch (error) {
      const currentSecureState = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, id) });
      const mustRollForwardSecureLink =
        currentSecureState?.secureLinkMigratedAt != null &&
        (currentSecureState.secureLinkStatus === 'provisioning' ||
          currentSecureState.secureLinkStatus === 'updating' ||
          currentSecureState.secureLinkStatus === 'cutover_ready');
      if (mustRollForwardSecureLink) {
        await this.secureLinks?.markCutoverError(id, error).catch(() => undefined);
        this.queueDockerReconciliation();
        if (error instanceof AppError) throw error;
        throw new AppError(
          500,
          'NGINX_CONFIG_FAILED',
          `Secure Link cutover will retry: ${error instanceof Error ? error.message : 'unknown error'}`
        );
      }
      if (nodeChanged && appliedOnTargetNode) {
        try {
          await this.removeConfigFromNode(id, updated.nodeId);
          await this.certificateDistribution.deactivateHost(id, updated.nodeId);
        } catch (cleanupError) {
          logger.warn('Failed to remove new-node config after proxy host move rollback', {
            hostId: id,
            nodeId: updated.nodeId,
            cleanupError,
          });
        }
        if (existing.enabled) {
          try {
            await this.restoreConfigOnNode(existing);
          } catch (restoreError) {
            logger.error('Failed to restore former-node config after proxy host move rollback', {
              hostId: id,
              nodeId: existing.nodeId,
              restoreError,
            });
          }
        }
      }
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
      if (existing.upstreamKind !== 'manual' || updated.upstreamKind !== 'manual') {
        for (const key of [
          'forwardHost',
          'forwardPort',
          'dockerHostPort',
          'secureLinkGeneration',
          'secureLinkStatus',
          'secureLinkLastError',
          'secureLinkTargetNetwork',
          'secureLinkTargetContainer',
          'secureLinkTargetHost',
          'secureLinkListenerPort',
          'secureLinkConnectorPort',
          'secureLinkMigratedAt',
        ] as const) {
          rollbackData[key] = existing[key];
        }
      }
      const rollbackSecureLinkGeneration =
        existing.secureLinkGeneration > 0
          ? Math.max(existing.secureLinkGeneration, updated.secureLinkGeneration) + 1
          : existing.secureLinkGeneration;
      rollbackData.secureLinkGeneration = rollbackSecureLinkGeneration;
      rollbackData.updatedAt = existing.updatedAt;
      try {
        await this.db.update(proxyHosts).set(rollbackData).where(eq(proxyHosts.id, id));
        if (updated.secureLinkGeneration > 0 && existing.secureLinkGeneration === 0) {
          await this.secureLinks?.cleanup(updated);
        } else if (existing.secureLinkGeneration > 0) {
          await this.secureLinks?.reconcileExisting({
            ...existing,
            secureLinkGeneration: rollbackSecureLinkGeneration,
          });
          if (formerDockerNodeId && updated.dockerNodeId) {
            await this.secureLinks?.reconcileTargetNode(updated.dockerNodeId);
          }
        }
      } catch (rollbackError) {
        logger.error('Failed to rollback DB after nginx config failure', {
          hostId: id,
          rollbackError,
        });
      }
      if (error instanceof AppError) throw error;
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

    // 2. Preserve the currently active deployment until Nginx has confirmed
    // the config removal. This avoids GCing a certificate for a still-serving host.
    try {
      await this.removeConfigFromNode(id, existing.nodeId);
      await this.certificateDistribution.deactivateHost(id, existing.nodeId);
    } catch (error) {
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to remove Nginx config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    // 3. Delete the database row only after the active deployment is safely gone.
    await this.secureLinks?.cleanup(existing);
    await this.db.delete(proxyHosts).where(eq(proxyHosts.id, id));

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
    const tlsDistribution = await this.certificateDistribution.getStatusForHost(host);

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
      tlsDistribution,
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

  async getProxySecureLinkStatus(id: string) {
    const host = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
      columns: {
        id: true,
        isSystem: true,
        upstreamKind: true,
        nodeId: true,
        dockerNodeId: true,
        secureLinkGeneration: true,
        secureLinkStatus: true,
        secureLinkLastError: true,
        secureLinkMigratedAt: true,
        healthCheckEnabled: true,
        healthCheckInterval: true,
        rateLimitEnabled: true,
        rateLimitMode: true,
        rateLimitOptions: true,
      },
    });
    if (!host || host.isSystem) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (host.upstreamKind === 'manual') {
      throw new AppError(409, 'SECURE_LINK_NOT_APPLICABLE', 'Proxy host does not use a Docker Secure Link');
    }

    const nodeIds = [host.nodeId, host.dockerNodeId].filter((nodeId): nodeId is string => Boolean(nodeId));
    const [linkNodes, history] = await Promise.all([
      nodeIds.length
        ? this.db
            .select({ id: nodes.id, hostname: nodes.hostname, displayName: nodes.displayName, status: nodes.status })
            .from(nodes)
            .where(inArray(nodes.id, nodeIds))
        : Promise.resolve([]),
      this.getSecureLinkRuntimeHistory(host.id),
    ]);
    const latestSnapshot = history.at(-1);
    const runtime = latestSnapshot?.runtime ?? null;
    const traffic = latestSnapshot?.traffic ?? null;

    // The read path never waits on Relay or daemon RPCs. An open Link Runtime
    // tab only accelerates the same sampler that already runs in the
    // background; the next poll observes the completed snapshot.
    void this.sampleSecureLinkRuntime(host, SECURE_LINK_FOCUSED_TRAFFIC_TAIL_LINES).catch((error) => {
      logger.debug('Focused Proxy Secure Link telemetry collection failed', {
        hostId: host.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    const nodeById = new Map(linkNodes.map((node) => [node.id, node]));
    const sourceNode = host.nodeId ? nodeById.get(host.nodeId) : undefined;
    const targetNode = host.dockerNodeId ? nodeById.get(host.dockerNodeId) : undefined;
    const rateLimitMode = host.rateLimitMode ?? (host.rateLimitEnabled ? 'custom' : 'inherit');
    const rateLimitOptions = (host.rateLimitOptions ?? {}) as {
      requestsPerSecond?: number;
      burst?: number;
      connectionsPerIp?: number;
    };
    const rateLimitEnabled = rateLimitMode !== 'disabled';
    return {
      state: host.secureLinkStatus,
      generation: host.secureLinkGeneration,
      sourceNodeId: host.nodeId,
      targetNodeId: host.dockerNodeId,
      transport: 'grpc-http2-mtls',
      migratedAt: host.secureLinkMigratedAt?.toISOString() ?? null,
      lastError: host.secureLinkLastError,
      healthCheck: {
        enabled: host.healthCheckEnabled,
        intervalSeconds: host.healthCheckInterval ?? 30,
      },
      sourceNode: sourceNode
        ? { id: sourceNode.id, name: sourceNode.displayName || sourceNode.hostname, status: sourceNode.status }
        : null,
      targetNode: targetNode
        ? { id: targetNode.id, name: targetNode.displayName || targetNode.hostname, status: targetNode.status }
        : null,
      rateLimit: {
        mode: rateLimitMode,
        enabled: rateLimitEnabled,
        requestsPerSecond:
          rateLimitMode === 'custom' ? (rateLimitOptions.requestsPerSecond ?? 1000) : rateLimitEnabled ? 1000 : 0,
        burst: rateLimitMode === 'custom' ? (rateLimitOptions.burst ?? 3000) : rateLimitEnabled ? 3000 : 0,
        connectionsPerIp:
          rateLimitMode === 'custom' ? (rateLimitOptions.connectionsPerIp ?? 1000) : rateLimitEnabled ? 1000 : 0,
      },
      runtime,
      traffic,
      history,
    };
  }

  /**
   * Collects the same runtime snapshots that the focused Link Runtime page
   * requests, but for every enabled active Secure Link. This background path
   * keeps monitoring history independent from browser sessions.
   */
  collectSecureLinkRuntimeSnapshots(): Promise<void> {
    if (this.secureLinkRuntimeBackgroundInFlight) return this.secureLinkRuntimeBackgroundInFlight;

    const task = this.collectSecureLinkRuntimeSnapshotsOnce().finally(() => {
      if (this.secureLinkRuntimeBackgroundInFlight === task) {
        this.secureLinkRuntimeBackgroundInFlight = null;
      }
    });
    this.secureLinkRuntimeBackgroundInFlight = task;
    return task;
  }

  private async collectSecureLinkRuntimeSnapshotsOnce(): Promise<void> {
    if (!this.secureLinks || this.dockerReconcileRunning) return;
    const hosts = await this.db.query.proxyHosts.findMany({
      where: and(
        eq(proxyHosts.isSystem, false),
        eq(proxyHosts.enabled, true),
        ne(proxyHosts.upstreamKind, 'manual'),
        eq(proxyHosts.secureLinkStatus, 'active')
      ),
      columns: { id: true, nodeId: true },
    });

    // Keep daemon and Relay fan-out bounded when an installation has many
    // Secure Links. A slow route cannot create overlapping background rounds.
    const concurrency = 4;
    for (let offset = 0; offset < hosts.length; offset += concurrency) {
      const batch = hosts.slice(offset, offset + concurrency);
      const results = await Promise.allSettled(
        batch.map((host) => this.sampleSecureLinkRuntime(host, SECURE_LINK_BACKGROUND_TRAFFIC_TAIL_LINES))
      );
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.debug('Background Proxy Secure Link telemetry collection failed', {
            hostId: batch[index]?.id,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });
    }
  }

  private sampleSecureLinkRuntime(
    host: { id: string; nodeId: string | null },
    trafficTailLines: number
  ): Promise<ProxySecureLinkRuntimeSample> {
    const active = this.secureLinkRuntimeSamplesInFlight.get(host.id);
    if (active) return active;

    const task = this.collectSecureLinkRuntimeSnapshot(host, trafficTailLines)
      .then(async (snapshot) => {
        await this.getSecureLinkRuntimeHistory(host.id);
        const history = this.recordSecureLinkRuntimeSnapshot(host.id, snapshot);
        await this.persistSecureLinkRuntimeHistory(host.id, history);
        return { snapshot, history };
      })
      .finally(() => {
        if (this.secureLinkRuntimeSamplesInFlight.get(host.id) === task) {
          this.secureLinkRuntimeSamplesInFlight.delete(host.id);
        }
      });
    this.secureLinkRuntimeSamplesInFlight.set(host.id, task);
    return task;
  }

  private async collectSecureLinkRuntimeSnapshot(
    host: {
      id: string;
      nodeId: string | null;
    },
    trafficTailLines: number
  ): Promise<ProxySecureLinkRuntimeSnapshot> {
    const [runtime, trafficResult] = await Promise.all([
      this.secureLinks?.getRuntime(host.id).catch((error) => {
        logger.debug('Proxy Secure Link route telemetry is unavailable', {
          hostId: host.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }) ?? Promise.resolve(null),
      host.nodeId
        ? this.nodeDispatch
            .requestTrafficStats(host.nodeId, trafficTailLines, { hostId: host.id, windowSeconds: 15 })
            .catch((error) => {
              logger.debug('Proxy Secure Link HTTP telemetry is unavailable', {
                hostId: host.id,
                error: error instanceof Error ? error.message : String(error),
              });
              return null;
            })
        : Promise.resolve(null),
    ]);

    let traffic: ProxyHostTrafficRuntime | null = null;
    if (trafficResult?.success && trafficResult.detail) {
      try {
        const parsed = JSON.parse(trafficResult.detail) as ProxyHostTrafficRuntime;
        // Older daemons ignore host_id and return node-global data. Never
        // present that fallback as telemetry for one Secure Link.
        if (parsed.hostId === host.id) traffic = parsed;
      } catch {
        traffic = null;
      }
    }

    return { timestamp: new Date().toISOString(), runtime, traffic };
  }

  private recordSecureLinkRuntimeSnapshot(
    hostId: string,
    snapshot: ProxySecureLinkRuntimeSnapshot
  ): ProxySecureLinkRuntimeSnapshot[] {
    const current = this.secureLinkRuntimeHistory.get(hostId) ?? [];
    const previous = current.at(-1);
    const relayRestarted =
      previous?.runtime != null &&
      snapshot.runtime != null &&
      (previous.runtime.metricsSince !== snapshot.runtime.metricsSince ||
        Number(snapshot.runtime.openedTotal) < Number(previous.runtime.openedTotal));
    const retained = relayRestarted ? [] : current;
    const previousTimestamp = retained.at(-1)?.timestamp;
    const elapsed = previousTimestamp
      ? new Date(snapshot.timestamp).getTime() - new Date(previousTimestamp).getTime()
      : Number.POSITIVE_INFINITY;
    const updated =
      elapsed < SECURE_LINK_RUNTIME_DEDUP_WINDOW_MS
        ? [...retained.slice(0, -1), snapshot]
        : [...retained, snapshot].slice(-60);
    this.secureLinkRuntimeHistory.set(hostId, updated);
    return [...updated];
  }

  private async getSecureLinkRuntimeHistory(hostId: string): Promise<ProxySecureLinkRuntimeSnapshot[]> {
    const current = this.secureLinkRuntimeHistory.get(hostId);
    if (current) return [...current];
    if (!this.cache) return [];

    try {
      const cached = await this.cache.get<ProxySecureLinkRuntimeSnapshot[]>(
        `${SECURE_LINK_RUNTIME_CACHE_PREFIX}${hostId}`
      );
      const history = Array.isArray(cached)
        ? cached
            .filter(
              (snapshot): snapshot is ProxySecureLinkRuntimeSnapshot =>
                snapshot != null &&
                typeof snapshot === 'object' &&
                typeof (snapshot as ProxySecureLinkRuntimeSnapshot).timestamp === 'string'
            )
            .slice(-60)
        : [];
      this.secureLinkRuntimeHistory.set(hostId, history);
      return [...history];
    } catch (error) {
      logger.debug('Proxy Secure Link runtime history cache is unavailable', {
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async persistSecureLinkRuntimeHistory(
    hostId: string,
    history: ProxySecureLinkRuntimeSnapshot[]
  ): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.set(
        `${SECURE_LINK_RUNTIME_CACHE_PREFIX}${hostId}`,
        history,
        SECURE_LINK_RUNTIME_CACHE_TTL_SECONDS
      );
    } catch (error) {
      logger.debug('Failed to persist Proxy Secure Link runtime history', {
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
        await this.applyConfigToNode(
          id,
          config,
          updated.nodeId,
          certPaths.preparedTls,
          this.configOwnershipForHost(updated)
        );
      } else {
        // Disable: remove config and reload
        await this.removeConfigFromNode(id, updated.nodeId);
        await this.certificateDistribution.deactivateHost(id, updated.nodeId);
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
      if (error instanceof AppError && error.code === 'NGINX_TLS_DAEMON_UPDATE_REQUIRED') throw error;
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
        const certPaths = await this.resolveCertPaths(updated, { preserveLegacyOnUnsupported: true });
        const accessList = await this.resolveAccessList(updated.accessListId);
        const config = await this.buildNginxConfig(updated, certPaths, accessList);
        await this.applyConfigToNode(
          id,
          config,
          updated.nodeId,
          certPaths.preparedTls,
          this.configOwnershipForHost(updated)
        );
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
    runImmediateProxyHealthCheck({ db: this.db, hostId, logger, nodeDispatch: this.nodeDispatch });
  }

  private queueDockerReconciliation(force = false): void {
    if (!this.dockerUpstreams) return;
    this.dockerReconcileDirty = true;
    this.dockerReconcileForce ||= force;
    if (this.dockerReconcileRunning) return;
    this.dockerReconcileRunning = true;
    void (async () => {
      try {
        do {
          this.dockerReconcileDirty = false;
          const reconcileForce = this.dockerReconcileForce;
          this.dockerReconcileForce = false;
          await this.reconcileDockerUpstreams(reconcileForce);
        } while (this.dockerReconcileDirty);
      } catch (error) {
        logger.error('Docker proxy upstream reconciliation failed', { error });
        this.scheduleDockerReconciliationRetry();
      } finally {
        this.dockerReconcileRunning = false;
        if (this.dockerReconcileDirty) this.queueDockerReconciliation();
      }
    })();
  }

  private scheduleDockerReconciliationRetry(): void {
    if (this.dockerReconcileRetry) return;
    const delay = this.dockerReconcileBackoffMs;
    this.dockerReconcileBackoffMs = Math.min(this.dockerReconcileBackoffMs * 2, 5 * 60_000);
    this.dockerReconcileRetry = setTimeout(() => {
      this.dockerReconcileRetry = undefined;
      this.queueDockerReconciliation(true);
    }, delay);
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

  private async resolveStoredDockerUpstream(host: ProxyHostRow, force = false): Promise<ProxyHostRow> {
    if (host.upstreamKind === 'manual' || !this.dockerUpstreams) return host;
    if (host.type === 'raw' || host.rawConfigEnabled) return host;
    const resolved = await this.dockerUpstreams.resolve(host, { allowPortRebind: true });
    const changed =
      host.dockerContainerPort !== resolved.dockerContainerPort ||
      host.dockerNodeId !== resolved.dockerNodeId ||
      host.dockerContainerName !== resolved.dockerContainerName ||
      host.dockerDeploymentId !== resolved.dockerDeploymentId;
    if (!changed && host.secureLinkStatus === 'active' && !force) return host;
    let updated = host;
    if (changed) {
      const [persisted] = await this.db
        .update(proxyHosts)
        .set({
          upstreamKind: resolved.upstreamKind,
          dockerNodeId: resolved.dockerNodeId,
          dockerContainerName: resolved.dockerContainerName,
          dockerDeploymentId: resolved.dockerDeploymentId,
          dockerContainerPort: resolved.dockerContainerPort,
          dockerProtocol: resolved.dockerProtocol,
          updatedAt: new Date(),
        })
        .where(eq(proxyHosts.id, host.id))
        .returning();
      updated = persisted ?? host;
    }
    return this.secureLinks ? this.secureLinks.reconcileExisting(updated) : updated;
  }

  private async reconcileDockerUpstreams(force = false): Promise<void> {
    let retryNeeded = false;
    const pendingCleanups = await this.db.query.proxyHosts.findMany({
      where: eq(proxyHosts.secureLinkStatus, 'cleanup_pending'),
    });
    for (const host of pendingCleanups) {
      try {
        await this.secureLinks?.cleanup(host);
      } catch (error) {
        logger.debug('Secure Link cleanup is still pending', { hostId: host.id, error });
        retryNeeded = true;
      }
    }
    const hosts = await this.db.query.proxyHosts.findMany({
      where: and(
        eq(proxyHosts.type, 'proxy'),
        ne(proxyHosts.upstreamKind, 'manual'),
        ne(proxyHosts.secureLinkStatus, 'cleanup_pending')
      ),
    });
    for (const host of hosts) {
      try {
        if (host.type === 'raw' || host.rawConfigEnabled) {
          if (host.secureLinkGeneration > 0) await this.secureLinks?.cleanup(host);
          continue;
        }
        const updated = await this.resolveStoredDockerUpstream(host, force);
        const secureLinkChanged =
          updated.forwardHost !== host.forwardHost ||
          updated.forwardPort !== host.forwardPort ||
          updated.secureLinkGeneration !== host.secureLinkGeneration ||
          updated.secureLinkStatus !== host.secureLinkStatus ||
          updated.secureLinkListenerPort !== host.secureLinkListenerPort ||
          updated.secureLinkTargetNetwork !== host.secureLinkTargetNetwork ||
          updated.secureLinkTargetContainer !== host.secureLinkTargetContainer;
        const cutoverPending =
          updated.secureLinkGeneration > 0 &&
          (updated.secureLinkStatus === 'provisioning' ||
            updated.secureLinkStatus === 'updating' ||
            updated.secureLinkStatus === 'cutover_ready');
        if (!secureLinkChanged && !cutoverPending) continue;
        let cutoverHost = updated;
        if (updated.secureLinkGeneration > 0 && updated.secureLinkStatus !== 'active') {
          if (host.secureLinkGeneration === 0 && host.enabled) {
            await this.removeConfigFromNode(host.id, host.nodeId);
          }
          await this.secureLinks?.commitCutover(updated.id);
          cutoverHost = (await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, updated.id) })) ?? updated;
        }
        if (cutoverHost.enabled) {
          try {
            const certPaths = await this.resolveCertPaths(cutoverHost, { preserveLegacyOnUnsupported: true });
            const accessList = await this.resolveAccessList(cutoverHost.accessListId);
            const config = await this.buildNginxConfig(cutoverHost, certPaths, accessList);
            await this.applyConfigToNode(
              cutoverHost.id,
              config,
              cutoverHost.nodeId,
              certPaths.preparedTls,
              this.configOwnershipForHost(cutoverHost)
            );
            if (cutoverHost.secureLinkGeneration > 0) await this.secureLinks?.activate(cutoverHost.id);
          } catch (error) {
            // Keep the newly resolved endpoint. A disconnected Nginx node will
            // receive it through the existing resync path after reconnecting.
            logger.warn('Resolved Docker upstream but could not apply Nginx config yet', {
              hostId: updated.id,
              error,
            });
            retryNeeded = true;
          }
        } else if (cutoverPending) {
          await this.secureLinks?.activate(cutoverHost.id);
        }
        this.emitHost(updated.id, 'updated', updated.domainNames?.[0]);
      } catch (error) {
        // External disappearance/offline state intentionally keeps the last
        // resolved endpoint and the existing Nginx configuration intact.
        logger.debug('Keeping last resolved Docker proxy upstream', { hostId: host.id, error });
        retryNeeded = true;
      }
    }
    if (retryNeeded) this.scheduleDockerReconciliationRetry();
    else this.dockerReconcileBackoffMs = 5_000;
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
    const supportsDistribution = await this.certificateDistribution.supportsNode(nodeId);

    for (const storedHost of hosts) {
      try {
        let host = storedHost;
        try {
          host = await this.resolveStoredDockerUpstream(storedHost);
        } catch (error) {
          // A node reconnect can race the background Docker reconciler. Never
          // render the stale pre-cutover row captured above: it could restore a
          // published-IP upstream after the Secure Link was already committed.
          const current = await this.db.query.proxyHosts.findFirst({
            where: eq(proxyHosts.id, storedHost.id),
          });
          if (!current?.enabled || current.nodeId !== nodeId) continue;
          host = current;
          logger.debug('Using current proxy state after Docker resync resolution failed', {
            hostId: storedHost.id,
            error,
          });
        }
        // Existing hosts on an old daemon retain their legacy config and
        // certificate paths. A new bundle is never initiated for that fleet.
        const certPaths = await this.resolveCertPaths(host, supportsDistribution ? {} : { legacy: true });
        const accessList = await this.resolveAccessList(host.accessListId);
        const config = await this.buildNginxConfig(host, certPaths, accessList);
        await this.applyConfigToNode(
          host.id,
          config,
          host.nodeId ?? nodeId,
          certPaths.preparedTls,
          this.configOwnershipForHost(host)
        );
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

  async resyncTlsHost(id: string, userId: string) {
    const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, id) });
    if (!host) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (!host.sslEnabled || !this.certificateDistribution.referenceForHost(host)) {
      throw new AppError(409, 'TLS_NOT_CONFIGURED', 'This proxy host has no TLS certificate to synchronize');
    }
    if (!host.enabled) {
      throw new AppError(
        409,
        'PROXY_HOST_DISABLED',
        'Enable the proxy host before synchronizing its TLS configuration'
      );
    }

    const certPaths = await this.resolveCertPaths(host);
    const accessList = await this.resolveAccessList(host.accessListId);
    const config = await this.buildNginxConfig(host, certPaths, accessList);
    await this.applyConfigToNode(
      host.id,
      config,
      host.nodeId,
      certPaths.preparedTls,
      this.configOwnershipForHost(host)
    );
    const distribution = await this.certificateDistribution.getStatusForHost(host);
    await this.auditService.log({
      userId,
      action: 'proxy_host.tls_resync',
      resourceType: 'proxy_host',
      resourceId: host.id,
      details: { nodeId: host.nodeId },
    });
    this.emitHost(host.id, 'tls_distribution_resynced', host.domainNames?.[0]);
    return { distribution };
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

    const certPaths = await this.resolveCertPaths(host, { prepare: false });
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
      await this.applyConfigToNode(
        host.id,
        config,
        host.nodeId,
        certPaths.preparedTls,
        this.configOwnershipForHost(host)
      );
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
      await this.certificateDistribution.deactivateHost(existing.id, existing.nodeId);
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

  private async resolveCertPaths(
    host: ProxyHostRow,
    options: { prepare?: boolean; legacy?: boolean; preserveLegacyOnUnsupported?: boolean } = {}
  ): Promise<CertPaths> {
    if (!host.sslEnabled) return { sslCertPath: null, sslKeyPath: null, sslChainPath: null };
    if (options.legacy) return this.certificateDistribution.legacyPathsForHost(host);
    if (options.preserveLegacyOnUnsupported && !(await this.certificateDistribution.supportsNode(host.nodeId))) {
      return this.certificateDistribution.legacyPathsForHost(host);
    }
    if (options.prepare === false) return this.certificateDistribution.peekPathsForHost(host);

    const preparedTls = await this.certificateDistribution.prepareForHost(host);
    if (!preparedTls) return { sslCertPath: null, sslKeyPath: null, sslChainPath: null };
    return {
      sslCertPath: preparedTls.sslCertPath,
      sslKeyPath: preparedTls.sslKeyPath,
      sslChainPath: preparedTls.sslChainPath,
      preparedTls,
    };
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
    // Raw mode is an explicit user-owned escape hatch and is never rewritten.
    if ((host.type === 'raw' || host.rawConfigEnabled) && host.rawConfig) return host.rawConfig;

    const usesSecureLink =
      host.upstreamKind !== 'manual' &&
      host.secureLinkGeneration > 0 &&
      host.secureLinkMigratedAt != null &&
      (host.secureLinkStatus === 'active' || host.secureLinkStatus === 'cutover_ready');
    if (usesSecureLink && !host.secureLinkListenerPort) {
      throw new Error('Secure Link listener port is unavailable');
    }
    const config: ProxyHostConfig = {
      id: host.id,
      type: host.type,
      domainNames: host.domainNames,
      enabled: host.enabled,
      forwardHost: usesSecureLink ? '127.0.0.1' : host.forwardHost,
      forwardPort: usesSecureLink ? host.secureLinkListenerPort : host.forwardPort,
      forwardScheme: host.forwardScheme ?? 'http',
      secureLinkUpstream: usesSecureLink,
      secureLinkSocketPath: usesSecureLink ? `/run/gateway-secure-links/${host.id}.sock` : undefined,
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
      rateLimitMode: host.rateLimitMode,
      rateLimitOptions: host.rateLimitOptions as Record<string, unknown> | null,
      customRewrites: (host.customRewrites ?? []) as { source: string; destination: string; type: string }[],
      advancedConfig: host.advancedConfig,
      accessList,
      sslCertPath: certPaths.sslCertPath,
      sslKeyPath: certPaths.sslKeyPath,
      sslChainPath: certPaths.sslChainPath,
      templateVariables: (host.templateVariables ?? {}) as Record<string, string | number | boolean>,
    };

    const rendered = await this.nginxTemplateService.renderForHost(config, host.nginxTemplateId ?? null);
    return host.maintenanceEnabled ? this.nginxTemplateService.applyMaintenanceGuard(rendered) : rendered;
  }
}
