import { and, eq, isNull, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { accessLists } from '@/db/schema/access-lists.js';
import { proxyHosts } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import type { PageRouteService } from '@/modules/pages/routes/page-route.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type {
  NginxCertificateDistributionService,
  PreparedTlsCertificate,
} from '@/services/nginx-certificate-distribution.service.js';
import type { NginxConfigGenerator, ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { RelayPoolService } from '@/services/relay-pool.service.js';
import type { AdditionalRouteService } from './additional-route.service.js';
import { supportsPagesRouteTemplate } from './additional-route-template.js';
import type { NginxTemplateService } from './nginx-template.service.js';
import type { CreateProxyHostInput, UpdateProxyHostInput } from './proxy.schemas.js';
import {
  type CertPaths,
  normalizeProxyValidationOptions,
  type ProxyValidationInput,
  updateUsesRawMode,
} from './proxy.service-helpers.js';
import {
  clearDockerUpstreamFields,
  type DockerUpstreamReference,
  type ProxyDockerUpstreamService,
} from './proxy-docker-upstream.service.js';
import type { ProxyMaintenanceAccessService } from './proxy-maintenance-access.service.js';
import type { ProxySecureLinkService } from './proxy-secure-link.service.js';
import type { WithDockerUpstreamDisplay } from './proxy-upstream-display.js';

export { __testOnly } from './proxy.service-helpers.js';

export const logger = createChildLogger('ProxyService');
export const SECURE_LINK_RUNTIME_DEDUP_WINDOW_MS = 500;
export const SECURE_LINK_BACKGROUND_TRAFFIC_TAIL_LINES = 200;
export const SECURE_LINK_FOCUSED_TRAFFIC_TAIL_LINES = 10_000;
// The focused UI retains 60 samples at a 2-second cadence.
export const SECURE_LINK_TRAFFIC_WINDOW_SECONDS = 2 * 60;
export const SECURE_LINK_RUNTIME_CACHE_PREFIX = 'proxy-secure-link-runtime:';
export const SECURE_LINK_RUNTIME_CACHE_TTL_SECONDS = 24 * 60 * 60;

export function sameDomainNames(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = left.map((domain) => domain.toLowerCase()).sort();
  const normalizedRight = right.map((domain) => domain.toLowerCase()).sort();
  return normalizedLeft.every((domain, index) => domain === normalizedRight[index]);
}

export function isDockerUpstream(kind: string): boolean {
  return kind === 'docker_container' || kind === 'docker_deployment';
}

export function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProxyHostRow = typeof proxyHosts.$inferSelect;
export type ProxyHostView = WithDockerUpstreamDisplay<ProxyHostRow>;

export interface ProxyHostTrafficRuntime {
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

export type ProxyRouteRuntime = Awaited<ReturnType<ProxySecureLinkService['getRuntime']>>;

export interface ProxySecureLinkRuntimeSnapshot {
  timestamp: string;
  runtime: ProxyRouteRuntime | null;
  traffic: ProxyHostTrafficRuntime | null;
}

export interface ProxySecureLinkRuntimeSample {
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

export interface RegistrySystemHostInput {
  domain: string;
  nodeId: string;
  sslCertificateId: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export abstract class ProxyServiceCore {
  protected abstract queueDockerReconciliation(force?: boolean): void;
  protected abstract refreshExternalBranding(): Promise<void>;
  protected abstract updateRenamedContainerReferences(nodeId: string, oldName: string, newName: string): Promise<void>;
  abstract collectSecureLinkRuntimeSnapshots(): Promise<void>;
  protected abstract requireManagedProxyHost(id: string): Promise<ProxyHostRow>;
  protected abstract runImmediateHealthCheck(hostId: string): void;
  protected abstract queueSecureLinkRuntimeSample(host: { id: string; nodeId: string | null }): void;

  constructor(
    protected readonly db: DrizzleClient,
    protected readonly nginxTemplateService: NginxTemplateService,
    protected readonly auditService: AuditService,
    protected readonly configGenerator: NginxConfigGenerator,
    protected readonly nodeDispatch: NodeDispatchService,
    protected readonly certificateDistribution: NginxCertificateDistributionService,
    protected readonly dockerUpstreams?: ProxyDockerUpstreamService,
    protected readonly secureLinks?: ProxySecureLinkService,
    protected readonly cache?: CacheService,
    protected readonly maintenanceAccess?: ProxyMaintenanceAccessService,
    protected readonly generalSettings?: GeneralSettingsService,
    protected readonly relayPool?: RelayPoolService
  ) {}

  protected eventBus?: EventBusService;
  protected notificationEvaluator?: NotificationEvaluatorService;
  protected pageRoutes?: PageRouteService;
  protected additionalRoutes?: AdditionalRouteService;
  protected dockerReconcileRunning = false;
  protected dockerReconcileDirty = false;
  protected dockerReconcileForce = false;
  protected dockerReconcileRetry?: ReturnType<typeof setTimeout>;
  protected dockerReconcileBackoffMs = 5_000;
  protected readonly secureLinkRuntimeHistory = new Map<string, ProxySecureLinkRuntimeSnapshot[]>();
  protected readonly secureLinkRuntimeSamplesInFlight = new Map<string, Promise<ProxySecureLinkRuntimeSample>>();
  protected secureLinkRuntimeBackgroundInFlight: Promise<void> | null = null;
  protected secureLinkRuntimeCollectionPending = false;
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
    bus.subscribe('docker.snapshot.changed', (payload) => {
      if ((payload as { kind?: string })?.kind === 'containers') this.queueDockerReconciliation();
    });
    bus.subscribe('docker.deployment.changed', () => this.queueDockerReconciliation());
    bus.subscribe('node.service_address.changed', () => this.queueDockerReconciliation(true));
    bus.subscribe('node.changed', () => this.queueDockerReconciliation(true));
    bus.subscribe('system.config.changed', (payload) => {
      if ((payload as { externalBrandingChanged?: boolean })?.externalBrandingChanged) {
        void this.refreshExternalBranding().catch((error) => {
          logger.error('Failed to refresh public proxy branding', { error });
        });
      }
    });
    bus.subscribe('docker.container.changed', (payload) => {
      const event = payload as { action?: string; nodeId?: string; name?: string; oldName?: string };
      if (event.action === 'renamed' && event.nodeId && event.name && event.oldName) {
        void this.updateRenamedContainerReferences(event.nodeId, event.oldName, event.name).catch((error) => {
          logger.error('Failed to update proxy references after container rename', { error });
        });
      }
    });
    bus.subscribe('nginx.template.changed', (payload) => {
      const event = payload as {
        id?: string;
        action?: string;
        renderingChanged?: boolean;
        type?: string;
        isBuiltin?: boolean;
      };
      if (event.id && event.action === 'updated' && event.renderingChanged === true) {
        void this.reconcileTemplateHosts(event.id, {
          type: event.type,
          isBuiltin: event.isBuiltin === true,
        }).catch((error) => {
          logger.error('Failed to reconcile routes after Nginx template update', {
            templateId: event.id,
            error,
          });
        });
      }
    });
    this.queueDockerReconciliation(true);
    // Do not wait for the first 10s scheduler tick. If startup reconciliation
    // is still using daemon command capacity, the collection is retained and
    // starts as soon as reconciliation releases it.
    void this.collectSecureLinkRuntimeSnapshots();
  }
  setEvaluator(evaluator: NotificationEvaluatorService) {
    this.notificationEvaluator = evaluator;
  }
  setPageRoutes(pageRoutes: PageRouteService) {
    this.pageRoutes = pageRoutes;
  }
  setAdditionalRoutes(additionalRoutes: AdditionalRouteService) {
    this.additionalRoutes = additionalRoutes;
    additionalRoutes.setHostRuntime(this);
  }

  /** Re-render a host after an Additional Route lifecycle transition. */
  async reconcileAdditionalRouteHost(hostId: string): Promise<void> {
    const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, hostId) });
    if (!host) return;
    if (!host.enabled) return;
    const certPaths = await this.resolveCertPaths(host, { preserveLegacyOnUnsupported: true });
    const accessList = await this.resolveAccessList(host.accessListId);
    const config = await this.buildNginxConfig(host, certPaths, accessList);
    await this.applyConfigToNode(
      host.id,
      config,
      host.nodeId,
      certPaths.preparedTls,
      this.configOwnershipForHost(host),
      host.accessListId
    );
  }

  async reconcileTemplateHosts(
    templateId: string,
    options: { type?: string; isBuiltin?: boolean } = {}
  ): Promise<{ total: number; succeeded: number; failed: number }> {
    const templateMatch =
      options.isBuiltin && options.type
        ? and(
            eq(proxyHosts.type, options.type as ProxyHostRow['type']),
            or(eq(proxyHosts.nginxTemplateId, templateId), isNull(proxyHosts.nginxTemplateId))
          )
        : eq(proxyHosts.nginxTemplateId, templateId);
    const hosts = await this.db.query.proxyHosts.findMany({
      where: and(templateMatch, eq(proxyHosts.enabled, true)),
    });
    let succeeded = 0;
    let failed = 0;

    for (const host of hosts) {
      try {
        await this.reconcileAdditionalRouteHost(host.id);
        succeeded += 1;
      } catch (error) {
        failed += 1;
        logger.error('Failed to regenerate route after Nginx template update', {
          templateId,
          hostId: host.id,
          nodeId: host.nodeId,
          error,
        });
      }
    }

    logger.info('Reconciled routes after Nginx template update', {
      templateId,
      total: hosts.length,
      succeeded,
      failed,
    });
    return { total: hosts.length, succeeded, failed };
  }
  protected reconcileMaintenanceAlerts(hostId?: string) {
    void this.notificationEvaluator?.reconcileProxyMaintenance(hostId).catch((error) => {
      logger.warn('Failed to reconcile proxy maintenance alerts', { hostId, error });
    });
  }
  protected emitHost(id: string, action: string, domain?: string, extra: Record<string, unknown> = {}) {
    this.eventBus?.publish('proxy.host.changed', { id, action, domain, ...extra });
  }

  protected async isGatewayPublicRoute(host: Pick<ProxyHostRow, 'domainNames'>): Promise<boolean> {
    const publicUrl = await this.generalSettings?.getPublicUrl();
    if (!publicUrl) return false;
    let publicHostname: string;
    try {
      publicHostname = normalizedHostname(new URL(publicUrl).hostname);
    } catch {
      return false;
    }
    return host.domainNames.some((domain) => normalizedHostname(domain) === publicHostname);
  }

  protected async applyConfigToNode(
    hostId: string,
    config: string,
    nodeId: string | null,
    preparedTls?: PreparedTlsCertificate | null,
    configOwnership = 'user_owned',
    accessListId?: string | null
  ): Promise<void> {
    const resolvedNodeId = preparedTls?.nodeId ?? (await this.nodeDispatch.resolveNodeId(nodeId));
    await this.deployAccessListCredentials(resolvedNodeId, accessListId);
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

  protected async deployAccessListCredentials(nodeId: string, accessListId?: string | null): Promise<void> {
    if (!accessListId) return;

    const list = await this.db.query.accessLists.findFirst({
      where: eq(accessLists.id, accessListId),
    });
    if (!list?.basicAuthEnabled) return;

    const users = list.basicAuthUsers as { username: string; passwordHash: string }[];
    if (users.length === 0) {
      throw new Error(`Access list ${accessListId} has basic auth enabled without credentials`);
    }
    const content = `${users.map((user) => `${user.username}:${user.passwordHash}`).join('\n')}\n`;
    const result = await this.nodeDispatch.deployHtpasswd(nodeId, accessListId, content);
    if (!result.success) {
      throw new Error(result.error || `Failed to deploy access list credentials to node ${nodeId}`);
    }
  }

  protected configOwnershipForHost(host: ProxyHostRow): 'managed_secure_link' | 'user_owned' {
    const committedSecureConfig = host.secureLinkGeneration > 0 && host.secureLinkMigratedAt != null;
    return host.type === 'proxy' &&
      !host.rawConfigEnabled &&
      isDockerUpstream(host.upstreamKind) &&
      committedSecureConfig
      ? 'managed_secure_link'
      : 'user_owned';
  }

  protected async restoreConfigOnNode(host: ProxyHostRow): Promise<void> {
    const certPaths = await this.resolveCertPaths(host, { preserveLegacyOnUnsupported: true });
    const accessList = await this.resolveAccessList(host.accessListId);
    const config = await this.buildNginxConfig(host, certPaths, accessList);
    await this.applyConfigToNode(
      host.id,
      config,
      host.nodeId,
      certPaths.preparedTls,
      this.configOwnershipForHost(host),
      host.accessListId
    );
  }

  protected async removeConfigFromNode(hostId: string, nodeId: string | null): Promise<void> {
    const resolvedNodeId = await this.nodeDispatch.resolveNodeId(nodeId);
    const result = await this.nodeDispatch.removeConfig(resolvedNodeId, hostId);
    if (!result.success) {
      throw new Error(result.error || 'Daemon config remove failed');
    }
  }

  protected async disablePageHostForDeferredCleanup(hostId: string, cleanupError: unknown): Promise<void> {
    try {
      await this.db.update(proxyHosts).set({ enabled: false, updatedAt: new Date() }).where(eq(proxyHosts.id, hostId));
    } catch (disableError) {
      logger.warn('Failed to disable Pages Route host retained for deferred cleanup', {
        hostId,
        cleanupError,
        disableError,
      });
    }
  }

  protected requireDockerUpstreams(): ProxyDockerUpstreamService {
    if (!this.dockerUpstreams) {
      throw new AppError(500, 'DOCKER_UPSTREAMS_UNAVAILABLE', 'Docker upstream resolution is unavailable');
    }
    return this.dockerUpstreams;
  }

  protected async assertPagesTemplateCompatible(templateId: string | null | undefined): Promise<void> {
    if (!templateId) return;
    const template = await this.nginxTemplateService.getTemplate(templateId);
    if (template.type === 'proxy' && supportsPagesRouteTemplate(template.content)) return;
    throw new AppError(
      400,
      'PAGES_ROUTE_TEMPLATE_UNSUPPORTED',
      'Select a proxy template that includes the managed Pages route placeholder'
    );
  }

  protected async prepareCreateUpstream(input: CreateProxyHostInput, options: ProxyValidationInput) {
    const normalized = normalizeProxyValidationOptions(options);
    if (input.type !== 'proxy' || input.rawConfigEnabled) {
      return { upstreamKind: 'manual' as const, forwardHost: null, forwardPort: null, ...clearDockerUpstreamFields() };
    }
    if (input.upstreamKind === 'manual') {
      return { upstreamKind: 'manual' as const, ...clearDockerUpstreamFields() };
    }
    if (input.upstreamKind === 'pages') {
      if (!this.pageRoutes) throw new AppError(503, 'PAGES_ROUTE_UNAVAILABLE', 'Pages Route service is unavailable');
      await this.pageRoutes.validateCreate(input);
      return {
        upstreamKind: 'pages' as const,
        forwardHost: null,
        forwardPort: null,
        ...clearDockerUpstreamFields(),
      };
    }
    return this.requireDockerUpstreams().resolve(input, {
      actorScopes: normalized.actorScopes,
      requireAvailable: true,
    });
  }

  protected async prepareUpdateUpstream(
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
    if (effectiveKind === 'pages' || existing.upstreamKind === 'pages') {
      if (effectiveKind !== 'pages' || existing.upstreamKind !== 'pages') {
        throw new AppError(
          409,
          'PAGES_ROUTE_KIND_CHANGE_UNSUPPORTED',
          'Recreate the Route to change its Pages target type'
        );
      }
      if (input.nodeId && input.nodeId !== existing.nodeId && !normalized.allowPagesNodeMove) {
        throw new AppError(409, 'PAGES_ROUTE_MIGRATION_REQUIRED', 'Move this Pages Route through ingress migration');
      }
      return {};
    }
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
      dockerComposeProjectId:
        input.dockerComposeProjectId === undefined ? existing.dockerComposeProjectId : input.dockerComposeProjectId,
      dockerComposeServiceName:
        input.dockerComposeServiceName === undefined
          ? existing.dockerComposeServiceName
          : input.dockerComposeServiceName,
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
      existing.dockerComposeProjectId !== reference.dockerComposeProjectId ||
      existing.dockerComposeServiceName !== reference.dockerComposeServiceName ||
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

  async validateAdvancedConfig(
    snippet: string,
    rawMode = false,
    bypassAdvancedValidation = false,
    bypassRawValidation = false,
    proxyHostId?: string
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

    if (proxyHostId) {
      await this.requireManagedProxyHost(proxyHostId);
      await this.secureLinks?.assertAdditionalReferences(proxyHostId, snippet);
    } else if (/\{\{additionalSecureLinks\./.test(snippet)) {
      return { valid: false, errors: ['Select a proxy host before validating additional Secure Link variables'] };
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

  protected async resolveCertPaths(
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

  protected async resolveAccessList(accessListId: string | null): Promise<ProxyHostConfig['accessList']> {
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

  protected async buildNginxConfig(
    host: ProxyHostRow,
    certPaths: CertPaths,
    accessList: ProxyHostConfig['accessList'],
    pagesRouteIncludePathOverride?: string
  ): Promise<string> {
    // Raw mode is an explicit user-owned escape hatch and is never rewritten.
    if ((host.type === 'raw' || host.rawConfigEnabled) && host.rawConfig) return host.rawConfig;

    const usesSecureLink =
      isDockerUpstream(host.upstreamKind) && host.secureLinkGeneration > 0 && host.secureLinkMigratedAt != null;
    const usesRegistryIngress = host.isSystem && host.systemKind === 'docker_registry';
    const additionalSecureLinks = this.secureLinks ? await this.secureLinks.getActiveAdditional(host.id) : [];
    const additionalRoutes = this.additionalRoutes ? await this.additionalRoutes.getRenderConfig(host.id) : [];
    await this.secureLinks?.assertAdditionalReferences(host.id, host.advancedConfig);
    if (host.upstreamKind === 'pages' && !this.pageRoutes) {
      throw new AppError(503, 'PAGES_ROUTE_UNAVAILABLE', 'Pages Route service is unavailable');
    }
    const pagesRouteConfig = host.upstreamKind === 'pages' ? await this.pageRoutes!.getRenderConfig(host.id) : null;
    const pagesRouteIncludePath = pagesRouteConfig
      ? (pagesRouteIncludePathOverride ?? pagesRouteConfig.includePath)
      : undefined;
    const registryAuthRealm = usesRegistryIngress
      ? new URL('/api/docker/registry/token', await this.generalSettings!.requirePublicUrl()).href
      : undefined;
    const config: ProxyHostConfig = {
      id: host.id,
      type: host.type,
      domainNames: host.domainNames,
      enabled: host.enabled,
      forwardHost: usesSecureLink || usesRegistryIngress ? '127.0.0.1' : host.forwardHost,
      forwardPort: usesSecureLink ? (host.secureLinkListenerPort ?? host.forwardPort) : host.forwardPort,
      forwardScheme: host.forwardScheme ?? 'http',
      upstreamIpv6Enabled: host.upstreamIpv6Enabled,
      secureLinkUpstream: usesSecureLink || usesRegistryIngress,
      secureLinkSocketPath: usesSecureLink
        ? `/run/gateway-secure-links/${host.id}.sock`
        : usesRegistryIngress
          ? `/run/gateway-registry-links/${host.id}.sock`
          : undefined,
      registryAuthRealm,
      additionalSecureLinks: additionalSecureLinks.map((binding) => ({
        id: binding.id,
        name: binding.name,
        scheme: binding.forwardScheme,
        socketPath: `/run/gateway-secure-links/${binding.id}.sock`,
      })),
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
      pagesRouteIncludePath,
      pagesSpaFallback: pagesRouteConfig?.spaFallback,
      pagesFallbackUrl: pagesRouteConfig?.fallbackUrl,
      additionalRoutes,
    };

    const hideExternalBranding = (await this.generalSettings?.getConfig())?.hideExternalBranding ?? false;
    const rendered = await this.nginxTemplateService.renderForHost(
      config,
      host.nginxTemplateId ?? null,
      hideExternalBranding
    );
    if (!host.maintenanceEnabled) return rendered;
    const access =
      this.maintenanceAccess && (await this.maintenanceAccess.isNodeSupported(host.nodeId))
        ? { hostId: host.id, secret: this.maintenanceAccess.secretForHost(host.id) }
        : undefined;
    return this.nginxTemplateService.applyMaintenanceGuard(rendered, access, hideExternalBranding);
  }
}
