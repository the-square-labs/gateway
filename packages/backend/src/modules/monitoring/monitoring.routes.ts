import { OpenAPIHono, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { streamSSE } from 'hono/streaming';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { proxyHosts } from '@/db/schema/index.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeBase } from '@/lib/permissions.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { authMiddleware, requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { MfaService } from '@/modules/auth/mfa.service.js';
import { DatabaseConnectionService } from '@/modules/databases/databases.service.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import { InferenceUsageService } from '@/modules/inference/accounting/inference-usage.service.js';
import { LoggingMaintenanceService } from '@/modules/logging/logging-maintenance.service.js';
import { NodesService } from '@/modules/nodes/nodes.service.js';
import { FinalizeSetupService } from '@/modules/onboarding/finalize-setup.service.js';
import { CAService } from '@/modules/pki/ca.service.js';
import { CertService } from '@/modules/pki/cert.service.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import { SSLService } from '@/modules/ssl/ssl.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { UpdateService } from '@/services/update.service.js';
import type { AppEnv } from '@/types.js';
import { getDashboardAttentionSeverity } from './dashboard-attention.js';
import { getNginxLogHistory, logRelay, type RelayedLogEntry } from './log-relay.service.js';
import {
  dashboardBootstrapRoute,
  dashboardStatsRoute,
  healthStatusRoute,
  proxyLogStreamRoute,
} from './monitoring.docs.js';
import { MonitoringService } from './monitoring.service.js';
import { subscribeNginxHostLogs } from './nginx-log-subscriptions.js';

export const monitoringRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

monitoringRoutes.use('*', authMiddleware);

// Dashboard stats — aggregate counts for proxy hosts, SSL certs, PKI certs, CAs
monitoringRoutes.openapi(dashboardStatsRoute, async (c) => {
  const monitoringService = container.resolve(MonitoringService);
  const showSystem = c.req.query('showSystem') === 'true';
  const scopes = c.get('effectiveScopes') || [];
  const canViewProxyStats = hasScopeBase(scopes, 'proxy:view');
  const canViewSslStats = hasScopeBase(scopes, 'ssl:cert:view');
  const canViewPkiCertStats = hasScopeBase(scopes, 'pki:cert:view');
  const canViewCaStats = hasScope(scopes, 'pki:ca:view:root') || hasScope(scopes, 'pki:ca:view:intermediate');
  const canViewNodeStats = hasScopeBase(scopes, 'nodes:details');
  const canViewSystemStats = showSystem && hasScope(scopes, 'admin:details:certificates');

  const stats = await monitoringService.getDashboardStats({
    showSystem: canViewSystemStats,
    allowedCaTypes: [
      hasScope(scopes, 'pki:ca:view:root') ? 'root' : null,
      hasScope(scopes, 'pki:ca:view:intermediate') ? 'intermediate' : null,
    ].filter((type): type is 'root' | 'intermediate' => !!type),
    allowedProxyHostIds: hasScope(scopes, 'proxy:view') ? undefined : getResourceScopedIds(scopes, 'proxy:view'),
    allowedSslCertificateIds: hasScope(scopes, 'ssl:cert:view')
      ? undefined
      : getResourceScopedIds(scopes, 'ssl:cert:view'),
    allowedPkiCertificateIds: hasScope(scopes, 'pki:cert:view')
      ? undefined
      : getResourceScopedIds(scopes, 'pki:cert:view'),
    allowedNodeIds: hasScope(scopes, 'nodes:details') ? undefined : getResourceScopedIds(scopes, 'nodes:details'),
  });
  return c.json({
    data: {
      proxyHosts: canViewProxyStats ? stats.proxyHosts : { total: 0, enabled: 0, online: 0, offline: 0, degraded: 0 },
      sslCertificates: canViewSslStats ? stats.sslCertificates : { total: 0, active: 0, expiringSoon: 0, expired: 0 },
      pkiCertificates: canViewPkiCertStats ? stats.pkiCertificates : { total: 0, active: 0, revoked: 0, expired: 0 },
      cas: canViewCaStats ? stats.cas : { total: 0, active: 0 },
      nodes: canViewNodeStats ? stats.nodes : { total: 0, online: 0, offline: 0, pending: 0 },
    },
  });
});

const DashboardBootstrapRequestSchema = z.object({
  showSystemCertificates: z.boolean().optional().default(false),
  showUpdateNotifications: z.boolean().optional().default(true),
  pins: z
    .object({
      dashboard: z
        .object({
          nodeIds: z.array(z.string().uuid()).max(100).optional().default([]),
          proxyHostIds: z.array(z.string().uuid()).max(100).optional().default([]),
          databaseIds: z.array(z.string().uuid()).max(100).optional().default([]),
          dockerResources: z
            .array(
              z.object({
                id: z.string().min(1).max(256),
                nodeId: z.string().uuid(),
                kind: z.enum(['container', 'deployment']),
                scopeResourceId: z.string().optional(),
              })
            )
            .max(100)
            .optional()
            .default([]),
        })
        .optional()
        .default({}),
      sidebar: z
        .object({
          nodeIds: z.array(z.string().uuid()).max(100).optional().default([]),
          proxyHostIds: z.array(z.string().uuid()).max(100).optional().default([]),
          databaseIds: z.array(z.string().uuid()).max(100).optional().default([]),
          dockerResources: z
            .array(
              z.object({
                id: z.string().min(1).max(256),
                nodeId: z.string().uuid(),
                kind: z.enum(['container', 'deployment']),
                scopeResourceId: z.string().optional(),
              })
            )
            .max(100)
            .optional()
            .default([]),
        })
        .optional()
        .default({}),
    })
    .optional()
    .default({}),
});

type DashboardDockerResource = {
  id: string;
  nodeId: string;
  name: string;
  state?: string;
  kind: 'container' | 'deployment';
  scopeResourceId?: string;
};

/**
 * Keep the scope calculation shared with the legacy stats endpoint while the
 * bootstrap response is introduced incrementally.  This route is deliberately
 * read-only: local pin placement remains a browser preference.
 */
monitoringRoutes.openapi(dashboardBootstrapRoute, async (c) => {
  const request = DashboardBootstrapRequestSchema.parse(await c.req.json());
  const scopes = c.get('effectiveScopes') || [];
  const showSystem = request.showSystemCertificates && hasScope(scopes, 'admin:details:certificates');
  const canViewProxy = hasScopeBase(scopes, 'proxy:view');
  const canViewSsl = hasScopeBase(scopes, 'ssl:cert:view');
  const canViewPki = hasScopeBase(scopes, 'pki:cert:view');
  const canViewCa = hasScope(scopes, 'pki:ca:view:root') || hasScope(scopes, 'pki:ca:view:intermediate');
  const canViewNodes = hasScopeBase(scopes, 'nodes:details');
  const canViewDatabases = hasScopeBase(scopes, 'databases:view');
  const canViewAudit = hasScope(scopes, 'admin:audit');
  const monitoringService = container.resolve(MonitoringService);
  const user = c.get('user')!;
  const canViewLogging = hasScope(scopes, 'housekeeping:view');
  const canViewInference = hasScope(scopes, 'inference:use') && hasScope(scopes, 'inference:usage:view:self');
  const nodeOptions = hasScope(scopes, 'nodes:details')
    ? undefined
    : { allowedIds: getResourceScopedIds(scopes, 'nodes:details') };
  const statsPromise = monitoringService.getDashboardStats({
    showSystem,
    allowedCaTypes: [
      hasScope(scopes, 'pki:ca:view:root') ? 'root' : null,
      hasScope(scopes, 'pki:ca:view:intermediate') ? 'intermediate' : null,
    ].filter((type): type is 'root' | 'intermediate' => !!type),
    allowedProxyHostIds: hasScope(scopes, 'proxy:view') ? undefined : getResourceScopedIds(scopes, 'proxy:view'),
    allowedSslCertificateIds: hasScope(scopes, 'ssl:cert:view')
      ? undefined
      : getResourceScopedIds(scopes, 'ssl:cert:view'),
    allowedPkiCertificateIds: hasScope(scopes, 'pki:cert:view')
      ? undefined
      : getResourceScopedIds(scopes, 'pki:cert:view'),
    allowedNodeIds: hasScope(scopes, 'nodes:details') ? undefined : getResourceScopedIds(scopes, 'nodes:details'),
  });
  const healthPromise = canViewProxy
    ? monitoringService.getHealthOverview(
        hasScope(scopes, 'proxy:view') ? undefined : { allowedHostIds: getResourceScopedIds(scopes, 'proxy:view') }
      )
    : Promise.resolve([]);
  const nodesPromise = canViewNodes
    ? container.resolve(NodesService).list({ page: 1, limit: 100 } as any, nodeOptions)
    : Promise.resolve({ data: [] as any[] });
  const sslPromise = canViewSsl
    ? container
        .resolve(SSLService)
        .listCerts(
          { page: 1, limit: 100, status: 'active', showSystem } as any,
          hasScope(scopes, 'ssl:cert:view') ? undefined : { allowedIds: getResourceScopedIds(scopes, 'ssl:cert:view') }
        )
    : Promise.resolve({ data: [] as any[] });
  const pkiPromise = canViewPki
    ? container
        .resolve(CertService)
        .listCertificates(
          { page: 1, limit: 100, status: 'active', showSystem } as any,
          hasScope(scopes, 'pki:cert:view') ? undefined : { allowedIds: getResourceScopedIds(scopes, 'pki:cert:view') }
        )
    : Promise.resolve({ data: [] as any[] });
  const finalizeSetupPromise = container.resolve(FinalizeSetupService).getForUser(user.id);
  const mfaPromise =
    user.authMethod === 'oidc'
      ? Promise.resolve(null)
      : Promise.all([
          container.resolve(MfaService).getStatus(user.id),
          container.resolve(MfaService).isGatewayMfaRequired(user.id),
          container.resolve(FinalizeSetupService).shouldShowMfaReminder(user.id),
        ]).then(([status, required, showReminder]) => ({ ...status, required, showReminder }));
  const updatePromise =
    hasScope(scopes, 'admin:update') && request.showUpdateNotifications
      ? container.resolve(UpdateService).getCachedStatus()
      : Promise.resolve(null);
  const loggingPromise = canViewLogging
    ? Promise.resolve(container.resolve(LoggingMaintenanceService).getSnapshot())
    : Promise.resolve(null);
  const inferencePromise = canViewInference
    ? container
        .resolve(InferenceUsageService)
        .self(user)
        // Usage is an optional dashboard card. An older installation can have
        // Gateway Inference enabled before a default budget policy exists; that
        // must not make the whole dashboard unavailable.
        .catch((error: unknown) => {
          if ((error as { code?: string } | null)?.code === 'budget_policy_unavailable') return null;
          throw error;
        })
    : Promise.resolve(null);
  const authMethodsPromise = container
    .resolve(AuthSettingsService)
    .getConfig()
    .then((config) => ({
      password: config.methods.password,
      emailOtp: config.methods.emailOtp,
    }));
  const casPromise = canViewCa
    ? container
        .resolve(CAService)
        .getCATree(showSystem)
        .then((cas) =>
          cas.filter((ca) =>
            ca.type === 'root' ? hasScope(scopes, 'pki:ca:view:root') : hasScope(scopes, 'pki:ca:view:intermediate')
          )
        )
    : Promise.resolve([]);
  const activityPromise = canViewAudit
    ? container
        .resolve(AuditService)
        .getAuditLog({ page: 1, limit: 6 })
        .then((result) => result.data)
    : Promise.resolve([]);
  const dashboardPinNodeIds = [...new Set(request.pins.dashboard.nodeIds)];
  const sidebarPinNodeIds = [...new Set(request.pins.sidebar.nodeIds)];
  const dashboardPinProxyIds = [...new Set(request.pins.dashboard.proxyHostIds)];
  const sidebarPinProxyIds = [...new Set(request.pins.sidebar.proxyHostIds)];
  const dashboardPinDatabaseIds = [...new Set(request.pins.dashboard.databaseIds)];
  const sidebarPinDatabaseIds = [...new Set(request.pins.sidebar.databaseIds)];
  const requestedProxyIds = [...new Set([...dashboardPinProxyIds, ...sidebarPinProxyIds])];
  const requestedDatabaseIds = [...new Set([...dashboardPinDatabaseIds, ...sidebarPinDatabaseIds])];
  const requestedDockerResources = [
    ...request.pins.dashboard.dockerResources,
    ...request.pins.sidebar.dockerResources,
  ].filter(
    (resource, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.kind === resource.kind && candidate.nodeId === resource.nodeId && candidate.id === resource.id
      ) === index
  );
  const pinnedProxyPromise =
    canViewProxy && requestedProxyIds.length > 0
      ? container
          .resolve(ProxyService)
          .listProxyHosts({ page: 1, limit: Math.min(100, requestedProxyIds.length) } as any, {
            allowedIds: requestedProxyIds.filter(
              (id) => hasScope(scopes, 'proxy:view') || hasScope(scopes, `proxy:view:${id}`)
            ),
          })
      : Promise.resolve({ data: [] as any[] });
  const pinnedDatabasePromise =
    canViewDatabases && requestedDatabaseIds.length > 0
      ? container
          .resolve(DatabaseConnectionService)
          .list({ page: 1, limit: Math.min(100, requestedDatabaseIds.length) } as any, {
            allowedIds: requestedDatabaseIds.filter(
              (id) => hasScope(scopes, 'databases:view') || hasScope(scopes, `databases:view:${id}`)
            ),
          })
      : Promise.resolve({ data: [] as any[] });
  const pinnedDockerPromise: Promise<DashboardDockerResource[]> = Promise.all(
    [...new Set(requestedDockerResources.map((resource) => resource.nodeId))].map(
      async (nodeId): Promise<DashboardDockerResource[]> => {
        const forNode = requestedDockerResources.filter((resource) => resource.nodeId === nodeId);
        if (!hasDockerResourceScope(scopes, 'docker:containers:view', nodeId, '')) {
          const scoped = await Promise.all(
            forNode.map(async (resource): Promise<DashboardDockerResource | null> => {
              if (resource.kind === 'deployment') {
                const deployment = await container.resolve(DockerDeploymentService).get(nodeId, resource.id);
                if (!hasDockerResourceScope(scopes, 'docker:containers:view', nodeId, deployment.id)) return null;
                return {
                  id: deployment.id,
                  nodeId,
                  name: deployment.name,
                  state: deployment._transition ?? deployment.status,
                  kind: 'deployment' as const,
                  scopeResourceId: resource.scopeResourceId ?? deployment.id,
                };
              }
              const containerData = await container
                .resolve(DockerManagementService)
                .inspectContainer(nodeId, resource.id);
              const scopeResourceId = String(containerData?.scopeResourceId ?? '');
              if (
                !scopeResourceId ||
                !hasDockerResourceScope(scopes, 'docker:containers:view', nodeId, scopeResourceId)
              ) {
                return null;
              }
              return {
                id: resource.id,
                nodeId,
                name: String(containerData?.Name ?? containerData?.name ?? resource.id).replace(/^\//, ''),
                state: containerData?._transition ?? containerData?.State?.Status ?? containerData?.state,
                kind: 'container' as const,
                scopeResourceId,
              };
            })
          );
          return scoped.filter((resource): resource is DashboardDockerResource => resource !== null);
        }

        const [containers, deployments] = await Promise.all([
          container.resolve(DockerManagementService).listContainers(nodeId),
          container.resolve(DockerDeploymentService).listSummary(nodeId),
        ]);
        return forNode.reduce<DashboardDockerResource[]>((resolved, resource) => {
          if (resource.kind === 'deployment') {
            const deployment = deployments.find((item) => item.id === resource.id);
            if (deployment) {
              resolved.push({
                id: deployment.id,
                nodeId,
                name: deployment.name,
                state: deployment._transition ?? deployment.status,
                kind: 'deployment' as const,
                scopeResourceId: resource.scopeResourceId ?? deployment.id,
              });
            }
            return resolved;
          }
          const containerData = containers.find(
            (item: any) => item.id === resource.id || item.scopeResourceId === resource.scopeResourceId
          );
          if (containerData) {
            resolved.push({
              id: resource.id,
              nodeId,
              name: String(containerData.name ?? containerData.Name ?? resource.id).replace(/^\//, ''),
              state: containerData._transition ?? containerData.state ?? containerData.State?.Status,
              kind: 'container' as const,
              scopeResourceId: containerData.scopeResourceId ?? resource.scopeResourceId,
            });
          }
          return resolved;
        }, []);
      }
    )
  ).then((groups) => groups.flat());
  const [
    stats,
    health,
    nodeResponse,
    sslResponse,
    pkiResponse,
    finalizeSetup,
    mfa,
    update,
    loggingHealth,
    inferenceUsage,
    inviteUserMethods,
    cas,
    activity,
    pinnedProxyResponse,
    pinnedDatabaseResponse,
    pinnedDockerResources,
  ] = await Promise.all([
    statsPromise,
    healthPromise,
    nodesPromise,
    sslPromise,
    pkiPromise,
    finalizeSetupPromise,
    mfaPromise,
    updatePromise,
    loggingPromise,
    inferencePromise,
    authMethodsPromise,
    casPromise,
    activityPromise,
    pinnedProxyPromise,
    pinnedDatabasePromise,
    pinnedDockerPromise,
  ]);
  const now = Date.now();
  const expiring = [
    ...sslResponse.data
      .filter(
        (certificate: any) =>
          certificate.notAfter &&
          new Date(certificate.notAfter).getTime() >= now &&
          new Date(certificate.notAfter).getTime() - now <= 30 * 24 * 60 * 60 * 1000
      )
      .map((certificate: any) => ({
        id: certificate.id,
        name: certificate.name,
        type: 'ssl',
        expiresAt: certificate.notAfter,
      })),
    ...pkiResponse.data
      .filter(
        (certificate: any) =>
          certificate.notAfter &&
          new Date(certificate.notAfter).getTime() >= now &&
          new Date(certificate.notAfter).getTime() - now <= 30 * 24 * 60 * 60 * 1000
      )
      .map((certificate: any) => ({
        id: certificate.id,
        name: certificate.commonName,
        type: 'pki',
        expiresAt: certificate.notAfter,
      })),
    ...cas
      .filter(
        (ca: any) =>
          ca.status === 'active' &&
          ca.notAfter &&
          new Date(ca.notAfter).getTime() >= now &&
          new Date(ca.notAfter).getTime() - now <= 30 * 24 * 60 * 60 * 1000
      )
      .map((ca: any) => ({ id: ca.id, name: ca.commonName, type: 'ca', expiresAt: ca.notAfter })),
  ];
  const mfaHasFactor = !!mfa && (mfa.totpConfigured || mfa.passkeyCount > 0);
  const lowInference = inferenceUsage
    ? [
        inferenceUsage.api,
        inferenceUsage.subscription['5h'],
        inferenceUsage.subscription['7d'],
        inferenceUsage.subscription['30d'],
      ].some((window) => window.configured && 100 - window.percentage < 20)
    : false;
  const nodeCapacityWarning = nodeResponse.data.some((node: any) => {
    const health = node.lastHealthReport;
    const disk = health?.diskMounts?.find((mount: any) => mount.mountPoint === '/');
    const memory =
      health?.systemMemoryTotalBytes > 0 ? (health.systemMemoryUsedBytes / health.systemMemoryTotalBytes) * 100 : 0;
    return health && (health.cpuPercent >= 80 || memory >= 80 || disk?.usagePercent >= 80);
  });
  const nodeHealthWarning = nodeResponse.data.some((node: any) =>
    ['offline', 'error', 'degraded'].includes(node.status)
  );
  const pinnedDatabaseWarning = pinnedDatabaseResponse.data.some((database: any) =>
    ['offline', 'degraded'].includes(database.healthStatus)
  );
  const pinnedDockerWarning = pinnedDockerResources.some((resource) =>
    ['failed', 'unhealthy', 'exited', 'dead', 'stopped', 'degraded'].includes(String(resource.state).toLowerCase())
  );
  const notices = [
    ...(canViewSsl && stats.sslCertificates.expiringSoon > 0
      ? [{ id: 'ssl-certificates-expiring', severity: 'warning' as const }]
      : []),
    ...(canViewPki && stats.pkiCertificates.expired > 0
      ? [{ id: 'pki-certificates-expired', severity: 'warning' as const }]
      : []),
    ...(canViewProxy && health.some((host) => ['offline', 'degraded', 'recovering'].includes(host.healthStatus ?? ''))
      ? [{ id: 'proxy-health', severity: 'warning' as const }]
      : []),
    ...(expiring.length > 0 ? [{ id: 'certificate-expiry', severity: 'warning' as const }] : []),
    ...(nodeCapacityWarning ? [{ id: 'node-capacity', severity: 'warning' as const }] : []),
    ...(nodeHealthWarning ? [{ id: 'node-health', severity: 'warning' as const }] : []),
    ...(pinnedDatabaseWarning ? [{ id: 'pinned-database-health', severity: 'warning' as const }] : []),
    ...(pinnedDockerWarning ? [{ id: 'pinned-docker-health', severity: 'warning' as const }] : []),
    ...(mfa && !mfaHasFactor && (mfa.required || mfa.showReminder)
      ? [{ id: 'mfa', severity: 'warning' as const }]
      : []),
    ...(update?.updateAvailable ? [{ id: 'gateway-update', severity: 'warning' as const }] : []),
    ...(loggingHealth && !['disabled', 'healthy'].includes(loggingHealth.status)
      ? [{ id: 'logging-health', severity: 'warning' as const }]
      : []),
    ...(lowInference ? [{ id: 'inference-usage', severity: 'warning' as const }] : []),
    ...(finalizeSetup && !(mfa && !mfaHasFactor && mfa.showReminder)
      ? [{ id: 'finalize-setup', severity: 'info' as const }]
      : []),
  ];
  const visibleNodes = new Map(nodeResponse.data.map((node: any) => [node.id, node]));
  const visibleProxies = new Map(pinnedProxyResponse.data.map((proxy: any) => [proxy.id, proxy]));
  const visibleDatabases = new Map(pinnedDatabaseResponse.data.map((database: any) => [database.id, database]));
  const nodeSlugs = new Map(nodeResponse.data.map((node: any) => [node.id, node.slug]));
  const visibleDockerResources = new Map(
    pinnedDockerResources.map((resource) => [
      `${resource.kind}:${resource.nodeId}:${resource.id}`,
      { ...resource, nodeSlug: nodeSlugs.get(resource.nodeId) ?? resource.nodeId },
    ])
  );
  const resolveByIds = <T>(ids: string[], values: Map<string, T>) =>
    ids.flatMap((id) => {
      const value = values.get(id);
      return value === undefined ? [] : [value];
    });
  const resolveDockerResources = (pins: typeof requestedDockerResources) =>
    pins.flatMap((pin) => {
      const value = visibleDockerResources.get(`${pin.kind}:${pin.nodeId}:${pin.id}`);
      return value === undefined ? [] : [value];
    });
  return c.json({
    data: {
      fetchedAt: new Date().toISOString(),
      stats: {
        proxyHosts: canViewProxy ? stats.proxyHosts : { total: 0, enabled: 0, online: 0, offline: 0, degraded: 0 },
        sslCertificates: canViewSsl ? stats.sslCertificates : { total: 0, active: 0, expiringSoon: 0, expired: 0 },
        pkiCertificates: canViewPki ? stats.pkiCertificates : { total: 0, active: 0, revoked: 0, expired: 0 },
        cas: canViewCa ? stats.cas : { total: 0, active: 0 },
        nodes: canViewNodes ? stats.nodes : { total: 0, online: 0, offline: 0, pending: 0 },
      },
      health,
      nodes: nodeResponse.data,
      expiring,
      cas,
      activity,
      finalizeSetup,
      mfa,
      update,
      loggingHealth,
      inferenceUsage,
      inviteUserMethods,
      pinned: {
        dashboard: {
          nodes: resolveByIds(dashboardPinNodeIds, visibleNodes),
          proxies: resolveByIds(dashboardPinProxyIds, visibleProxies),
          databases: resolveByIds(dashboardPinDatabaseIds, visibleDatabases),
          dockerResources: resolveDockerResources(request.pins.dashboard.dockerResources),
        },
        sidebar: {
          nodes: resolveByIds(sidebarPinNodeIds, visibleNodes),
          proxies: resolveByIds(sidebarPinProxyIds, visibleProxies),
          databases: resolveByIds(sidebarPinDatabaseIds, visibleDatabases),
          dockerResources: resolveDockerResources(request.pins.sidebar.dockerResources),
        },
      },
      requestedPins: request.pins,
      attention: {
        severity: getDashboardAttentionSeverity(notices),
        notices,
      },
    },
  });
});

// Health overview — all proxy hosts with health status, ordered by severity
monitoringRoutes.openapi(healthStatusRoute, async (c) => {
  const scopes = c.get('effectiveScopes') || [];
  if (!hasScopeBase(scopes, 'proxy:view')) {
    return c.json({ data: [] });
  }
  const monitoringService = container.resolve(MonitoringService);
  const overview = await monitoringService.getHealthOverview(
    hasScope(scopes, 'proxy:view') ? undefined : { allowedHostIds: getResourceScopedIds(scopes, 'proxy:view') }
  );
  return c.json({ data: overview });
});

monitoringRoutes.openapi(
  { ...proxyLogStreamRoute, middleware: requireScopeForResource('proxy:view', 'hostId') },
  async (c) => {
    const hostId = c.req.param('hostId')!;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hostId)) {
      return c.json({ code: 'INVALID_ID', message: 'Invalid host ID' }, 400);
    }

    const db = container.resolve(TOKENS.DrizzleClient) as DrizzleClient;
    const [host] = await db
      .select({ nodeId: proxyHosts.nodeId })
      .from(proxyHosts)
      .where(eq(proxyHosts.id, hostId))
      .limit(1);

    if (!host) return c.json({ code: 'NOT_FOUND', message: 'Proxy host not found' }, 404);

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        data: JSON.stringify({ connected: true, hostId }),
        event: 'connected',
      });

      if (!host.nodeId) {
        await stream.writeSSE({
          data: JSON.stringify({ message: 'Proxy host has no nginx node assigned' }),
          event: 'log-error',
        });
        return;
      }

      const nodeRegistry = container.resolve(NodeRegistryService);
      const subscription = subscribeNginxHostLogs(nodeRegistry, host.nodeId, hostId, 0);
      if (!subscription.ok) {
        await stream.writeSSE({
          data: JSON.stringify({ message: subscription.message }),
          event: 'log-error',
        });
        return;
      }

      // Subscribe to log entries for this host
      const onLog = (entry: RelayedLogEntry) => {
        if (entry.nodeId === host.nodeId && entry.hostId === hostId) {
          stream.writeSSE({ data: JSON.stringify(entry), event: 'log' }).catch(() => {});
        }
      };
      logRelay.on('log', onLog);

      for (const entry of getNginxLogHistory(hostId)) {
        if (entry.nodeId !== host.nodeId) continue;
        await stream.writeSSE({ data: JSON.stringify(entry), event: 'log' });
      }

      const keepalive = setInterval(() => {
        stream.writeSSE({ data: '', event: 'ping' }).catch(() => clearInterval(keepalive));
      }, 30_000);

      stream.onAbort(() => {
        clearInterval(keepalive);
        logRelay.off('log', onLog);
        subscription.cleanup();
      });

      await new Promise(() => {});
    });
  }
);
