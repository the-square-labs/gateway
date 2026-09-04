import { OpenAPIHono, z } from '@hono/zod-openapi';
import { eq, inArray } from 'drizzle-orm';
import { streamSSE } from 'hono/streaming';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { nodes, proxyHosts } from '@/db/schema/index.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeBase } from '@/lib/permissions.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { authMiddleware, requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { MfaService } from '@/modules/auth/mfa.service.js';
import { DatabaseConnectionService } from '@/modules/databases/databases.service.js';
import { DockerAvailabilityService } from '@/modules/docker/availability/docker-availability.service.js';
import { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import { DockerBuildQuery } from '@/modules/docker/docker-build-query.js';
import { DockerHealthCheckService } from '@/modules/docker/docker-health-check.service.js';
import { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import { InferenceUsageService } from '@/modules/inference/accounting/inference-usage.service.js';
import { LoggingMaintenanceService } from '@/modules/logging/logging-maintenance.service.js';
import { NodesService } from '@/modules/nodes/nodes.service.js';
import { FinalizeSetupService, isFinalizeSetupComplete } from '@/modules/onboarding/finalize-setup.service.js';
import { CAService } from '@/modules/pki/ca.service.js';
import { CertService } from '@/modules/pki/cert.service.js';
import { ProxyService } from '@/modules/proxy/proxy.service.js';
import { SSLService } from '@/modules/ssl/ssl.service.js';
import { DaemonUpdateService } from '@/services/daemon-update.service.js';
import { NginxCertificateDistributionService } from '@/services/nginx-certificate-distribution.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { RelaySupervisorService } from '@/services/relay-supervisor.service.js';
import { ResourceSnapshotStore } from '@/services/resource-snapshot.store.js';
import { SessionService } from '@/services/session.service.js';
import { UpdateService } from '@/services/update.service.js';
import type { AppEnv } from '@/types.js';
import {
  getDashboardAttentionSeverity,
  hasDashboardPinnedDatabaseWarning,
  hasDashboardPinnedDockerWarning,
} from './dashboard-attention.js';
import { DashboardReadModelService, dashboardStatsFromSourceSnapshots } from './dashboard-read-model.service.js';
import { getNginxLogHistory, logRelay, type RelayedLogEntry } from './log-relay.service.js';
import {
  dashboardBootstrapRoute,
  dashboardStatsRoute,
  healthStatusRoute,
  proxyLogStreamRoute,
} from './monitoring.docs.js';
import { MonitoringService } from './monitoring.service.js';
import { healthNavigationAttention, nodeNavigationAttention } from './navigation-attention.js';
import { subscribeNginxHostLogs } from './nginx-log-subscriptions.js';

export const monitoringRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

monitoringRoutes.use('*', authMiddleware);

async function scopedDashboardStatsFromReadModels(
  scopes: string[],
  showSystem: boolean,
  fallback: () => Promise<Awaited<ReturnType<MonitoringService['getDashboardStats']>>>
) {
  const canViewProxy = hasScopeBase(scopes, 'proxy:view');
  const canViewSsl = hasScopeBase(scopes, 'ssl:cert:view');
  const canViewPki = hasScopeBase(scopes, 'pki:cert:view');
  const canViewCa = hasScope(scopes, 'pki:ca:view:root') || hasScope(scopes, 'pki:ca:view:intermediate');
  const canViewNodes = hasScopeBase(scopes, 'nodes:details');
  const readModels = container.resolve(DashboardReadModelService);
  const [proxies, ssl, pki, cas, nodes] = await Promise.all([
    canViewProxy ? readModels.get<any[]>('proxies') : Promise.resolve(null),
    canViewSsl ? readModels.get<any[]>('ssl') : Promise.resolve(null),
    canViewPki ? readModels.get<any[]>('pki') : Promise.resolve(null),
    canViewCa ? readModels.get<any[]>('cas') : Promise.resolve(null),
    canViewNodes ? container.resolve(ResourceSnapshotStore).get<any[]>('ui-shell-nodes', 'all') : Promise.resolve(null),
  ]);
  const required = [
    ...(canViewProxy ? [proxies] : []),
    ...(canViewSsl ? [ssl] : []),
    ...(canViewPki ? [pki] : []),
    ...(canViewCa ? [cas] : []),
    ...(canViewNodes ? [nodes] : []),
  ];
  if (required.some((snapshot) => !snapshot || snapshot.revision === 0)) return fallback();

  return dashboardStatsFromSourceSnapshots(
    {
      proxies: proxies?.data ?? [],
      ssl: ssl?.data ?? [],
      pki: pki?.data ?? [],
      cas: cas?.data ?? [],
      nodes: nodes?.data ?? [],
    },
    {
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
    }
  );
}

// Dashboard stats — aggregate counts for proxy hosts, SSL certs, PKI certs, CAs
monitoringRoutes.openapi(dashboardStatsRoute, async (c) => {
  const monitoringService = container.resolve(MonitoringService);
  const dashboardReadModels = container.resolve(DashboardReadModelService);
  const showSystem = c.req.query('showSystem') === 'true';
  const scopes = c.get('effectiveScopes') || [];
  const canViewProxyStats = hasScopeBase(scopes, 'proxy:view');
  const canViewSslStats = hasScopeBase(scopes, 'ssl:cert:view');
  const canViewPkiCertStats = hasScopeBase(scopes, 'pki:cert:view');
  const canViewCaStats = hasScope(scopes, 'pki:ca:view:root') || hasScope(scopes, 'pki:ca:view:intermediate');
  const canViewNodeStats = hasScopeBase(scopes, 'nodes:details');
  const canViewSystemStats = showSystem && hasScope(scopes, 'admin:details:certificates');
  const directStats = () =>
    monitoringService.getDashboardStats({
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
  // A global aggregate can be returned unchanged only when every category the
  // caller can see is broad. Scoped grants must retain their existing DB-side
  // filtering before anything reaches the response.
  const canUseGlobalSnapshot =
    (!canViewProxyStats || hasScope(scopes, 'proxy:view')) &&
    (!canViewSslStats || hasScope(scopes, 'ssl:cert:view')) &&
    (!canViewPkiCertStats || hasScope(scopes, 'pki:cert:view')) &&
    (!canViewNodeStats || hasScope(scopes, 'nodes:details')) &&
    (!canViewCaStats || (hasScope(scopes, 'pki:ca:view:root') && hasScope(scopes, 'pki:ca:view:intermediate')));
  const snapshot = canUseGlobalSnapshot
    ? await dashboardReadModels.get<any>(canViewSystemStats ? 'stats-system' : 'stats-user')
    : null;
  const stats =
    snapshot && snapshot.revision > 0
      ? snapshot.data
      : canUseGlobalSnapshot
        ? await directStats()
        : await scopedDashboardStatsFromReadModels(scopes, canViewSystemStats, directStats);
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
                kind: z.enum(['container', 'deployment', 'build', 'compose']),
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
                kind: z.enum(['container', 'deployment', 'build', 'compose']),
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
  kind: 'container' | 'deployment' | 'build' | 'compose';
  scopeBase: 'docker:containers:view' | 'docker:compose:view';
  scopeResourceId?: string;
};

function hasNodeCapacityWarning(node: any): boolean {
  const health = node.lastHealthReport;
  const disk = health?.diskMounts?.find((mount: any) => mount.mountPoint === '/');
  const memory =
    health?.systemMemoryTotalBytes > 0 ? (health.systemMemoryUsedBytes / health.systemMemoryTotalBytes) * 100 : 0;
  return Boolean(health && (health.cpuPercent >= 80 || memory >= 80 || disk?.usagePercent >= 80));
}

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
  const dashboardReadModels = container.resolve(DashboardReadModelService);
  const user = c.get('user')!;
  const canViewLogging = hasScope(scopes, 'housekeeping:view');
  const canViewInference = hasScope(scopes, 'feat:ai:use');
  const scopedNodeIds = getResourceScopedIds(scopes, 'nodes:details');
  const nodeOptions = hasScope(scopes, 'nodes:details') ? undefined : { allowedIds: scopedNodeIds };
  const directStats = () =>
    monitoringService.getDashboardStats({
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
  const hasBroadStatsAccess =
    (!canViewProxy || hasScope(scopes, 'proxy:view')) &&
    (!canViewSsl || hasScope(scopes, 'ssl:cert:view')) &&
    (!canViewPki || hasScope(scopes, 'pki:cert:view')) &&
    (!canViewNodes || hasScope(scopes, 'nodes:details')) &&
    (!canViewCa || (hasScope(scopes, 'pki:ca:view:root') && hasScope(scopes, 'pki:ca:view:intermediate')));
  const statsPromise = hasBroadStatsAccess
    ? dashboardReadModels
        .get<any>(showSystem ? 'stats-system' : 'stats-user')
        // Revision zero is the coordinator's in-progress placeholder, not a
        // real (empty) dashboard.  Do the safe service fallback only until a
        // first complete projection exists; subsequent refreshes keep serving
        // the last-known-good snapshot.
        .then((snapshot) => (snapshot && snapshot.revision > 0 ? snapshot.data : directStats()))
    : scopedDashboardStatsFromReadModels(scopes, showSystem, directStats);
  const healthPromise = canViewProxy
    ? dashboardReadModels.get<any[]>('health').then((snapshot) => {
        const health = snapshot && snapshot.revision > 0 ? snapshot.data : null;
        if (!health) {
          return monitoringService.getHealthOverview(
            hasScope(scopes, 'proxy:view') ? undefined : { allowedHostIds: getResourceScopedIds(scopes, 'proxy:view') }
          );
        }
        if (hasScope(scopes, 'proxy:view')) return health;
        const allowed = new Set(getResourceScopedIds(scopes, 'proxy:view'));
        return health.filter((host) => allowed.has(host.id));
      })
    : Promise.resolve([]);
  const nodesPromise = canViewNodes
    ? (async () => {
        const snapshot = await container.resolve(ResourceSnapshotStore).get<any[]>('ui-shell-nodes', 'all');
        if (snapshot && snapshot.revision > 0) {
          const visible = hasScope(scopes, 'nodes:details')
            ? snapshot.data
            : snapshot.data.filter((node) => scopedNodeIds.includes(node.id));
          return { data: visible.slice(0, 100) };
        }
        // Redis-cold fallback is database/registry-only; never a daemon RPC.
        return container.resolve(NodesService).list({ page: 1, limit: 100 }, nodeOptions);
      })()
    : Promise.resolve({ data: [] as any[] });
  const sslPromise = canViewSsl
    ? dashboardReadModels.get<any[]>('ssl').then(async (snapshot) => {
        if (!snapshot || snapshot.revision === 0) {
          return container
            .resolve(SSLService)
            .listCerts(
              { page: 1, limit: 100, status: 'active', showSystem } as any,
              hasScope(scopes, 'ssl:cert:view')
                ? undefined
                : { allowedIds: getResourceScopedIds(scopes, 'ssl:cert:view') }
            );
        }
        const allowed = new Set(getResourceScopedIds(scopes, 'ssl:cert:view'));
        return {
          data: snapshot.data
            .filter((certificate) => certificate.status === 'active')
            .filter((certificate) => showSystem || !certificate.isSystem)
            .filter((certificate) => hasScope(scopes, 'ssl:cert:view') || allowed.has(certificate.id))
            .slice(0, 100),
        };
      })
    : Promise.resolve({ data: [] as any[] });
  const pkiPromise = canViewPki
    ? dashboardReadModels.get<any[]>('pki').then(async (snapshot) => {
        if (!snapshot || snapshot.revision === 0) {
          return container
            .resolve(CertService)
            .listCertificates(
              { page: 1, limit: 100, status: 'active', showSystem } as any,
              hasScope(scopes, 'pki:cert:view')
                ? undefined
                : { allowedIds: getResourceScopedIds(scopes, 'pki:cert:view') }
            );
        }
        const allowed = new Set(getResourceScopedIds(scopes, 'pki:cert:view'));
        return {
          data: snapshot.data
            .filter((certificate) => certificate.status === 'active')
            .filter((certificate) => showSystem || !certificate.isSystem)
            .filter((certificate) => hasScope(scopes, 'pki:cert:view') || allowed.has(certificate.id))
            .slice(0, 100),
        };
      })
    : Promise.resolve({ data: [] as any[] });
  const finalizeSetupPromise = container.resolve(FinalizeSetupService).getForUser(user.id);
  const browserSessionPromise =
    user.authMethod !== 'oidc' && c.get('sessionId')
      ? container.resolve(SessionService).getSession(c.get('sessionId')!)
      : Promise.resolve(null);
  const mfaPromise =
    user.authMethod === 'oidc'
      ? Promise.resolve(null)
      : Promise.all([
          container.resolve(MfaService).getStatus(user.id),
          container.resolve(MfaService).isGatewayMfaRequired(user.id),
          container.resolve(FinalizeSetupService).shouldShowMfaReminder(user.id),
          browserSessionPromise,
        ]).then(([status, required, showReminder, session]) => ({
          ...status,
          required,
          showReminder,
          sessionMfaSatisfied: session?.mfaSatisfiedAt !== undefined,
          graceExpiresAt:
            required &&
            session?.mfaSatisfiedAt === undefined &&
            typeof session?.mfaGraceExpiresAt === 'number' &&
            Number.isFinite(session.mfaGraceExpiresAt)
              ? session.mfaGraceExpiresAt
              : null,
        }));
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
  const daemonUpdatesPromise =
    canViewNodes && hasScope(scopes, 'admin:update')
      ? container.resolve(DaemonUpdateService).getCachedStatus()
      : Promise.resolve([]);
  const dockerNavigationHealthPromise = hasScopeBase(scopes, 'docker:containers:view')
    ? container
        .resolve(DockerHealthCheckService)
        .listNavigationHealth()
        .then(async (rows) => {
          const visible = rows.filter((row) =>
            hasDockerResourceScope(scopes, 'docker:containers:view', row.nodeId, row.resourceId)
          );
          if (visible.length === 0) return visible;
          const availability = container.resolve(DockerAvailabilityService);
          const states = new Map(
            await Promise.all(
              [...new Set(visible.map((row) => row.nodeId))].map(
                async (nodeId) =>
                  [
                    nodeId,
                    await availability.listContainerSurfaceStates(
                      nodeId,
                      visible
                        .filter((row) => row.nodeId === nodeId)
                        .map((row) => ({
                          name: row.containerName ?? '',
                          deploymentId: row.deploymentId,
                        }))
                    ),
                  ] as const
              )
            )
          );
          return visible.map((row) => {
            const key = row.deploymentId ? `deployment:${row.deploymentId}` : `container:${row.containerName}`;
            const logical = states.get(row.nodeId)?.[key];
            return logical ? { ...row, healthStatus: logical.healthStatus } : row;
          });
        })
    : Promise.resolve([]);
  const authMethodsPromise = container
    .resolve(AuthSettingsService)
    .getConfig()
    .then((config) => ({
      password: config.methods.password,
      emailOtp: config.methods.emailOtp,
    }));
  const casPromise = canViewCa
    ? dashboardReadModels.get<any[]>('cas').then(async (snapshot) => {
        const rows =
          snapshot && snapshot.revision > 0 ? snapshot.data : await container.resolve(CAService).getCATree(true);
        return rows
          .filter((ca) => showSystem || !ca.isSystem)
          .filter((ca) =>
            ca.type === 'root' ? hasScope(scopes, 'pki:ca:view:root') : hasScope(scopes, 'pki:ca:view:intermediate')
          );
      })
    : Promise.resolve([]);
  const activityPromise = canViewAudit
    ? container
        .resolve(AuditService)
        .getAuditLog({ page: 1, limit: 6 })
        .then((result) => result.data)
    : Promise.resolve([]);
  const tlsRepairFailuresPromise = canViewSsl
    ? container.resolve(NginxCertificateDistributionService).getActiveRepairFailureCount()
    : Promise.resolve(0);
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
      ? dashboardReadModels.get<any[]>('proxies').then(async (snapshot) => {
          const allowedIds = requestedProxyIds.filter(
            (id) => hasScope(scopes, 'proxy:view') || hasScope(scopes, `proxy:view:${id}`)
          );
          if (snapshot && snapshot.revision > 0) {
            const allowed = new Set(allowedIds);
            return { data: snapshot.data.filter((proxy) => allowed.has(proxy.id)) };
          }
          return container
            .resolve(ProxyService)
            .listProxyHosts({ page: 1, limit: Math.min(100, allowedIds.length) } as any, { allowedIds });
        })
      : Promise.resolve({ data: [] as any[] });
  const pinnedDatabasePromise =
    canViewDatabases && requestedDatabaseIds.length > 0
      ? dashboardReadModels.get<any[]>('databases').then(async (snapshot) => {
          const allowedIds = requestedDatabaseIds.filter(
            (id) => hasScope(scopes, 'databases:view') || hasScope(scopes, `databases:view:${id}`)
          );
          if (snapshot && snapshot.revision > 0) {
            const allowed = new Set(allowedIds);
            return { data: snapshot.data.filter((database) => allowed.has(database.id)) };
          }
          return container
            .resolve(DatabaseConnectionService)
            .list({ page: 1, limit: Math.min(100, allowedIds.length) } as any, { allowedIds });
        })
      : Promise.resolve({ data: [] as any[] });
  const pinnedDockerPromise: Promise<DashboardDockerResource[]> = Promise.all(
    [...new Set(requestedDockerResources.map((resource) => resource.nodeId))].map(
      async (nodeId): Promise<DashboardDockerResource[]> => {
        const forNode = requestedDockerResources.filter((resource) => resource.nodeId === nodeId);
        const runtimeResources = forNode.filter(
          (resource) => resource.kind === 'container' || resource.kind === 'deployment'
        );
        // Dashboard reads the already reconciled daemon inventory.  Decorating
        // the snapshot may read Gateway metadata, but must never issue a live
        // Docker command while a user is opening a page.
        const snapshot = runtimeResources.length
          ? await container.resolve(DockerSnapshotService).getList<Record<string, unknown>[]>(nodeId, 'containers')
          : { data: [] as Record<string, unknown>[] };
        const containers = runtimeResources.length
          ? await container
              .resolve(DockerManagementService)
              .decoratePublicContainerSnapshot(nodeId, Array.isArray(snapshot.data) ? snapshot.data : [])
          : [];
        const resolved: DashboardDockerResource[] = [];
        for (const resource of forNode) {
          if (resource.kind === 'build') {
            const build = await container
              .resolve(DockerBuildQuery)
              .get(resource.id)
              .catch(() => null);
            if (build?.target.kind === 'pages_project') continue;
            if (!build || build.target.nodeId !== nodeId) continue;
            const scopeResourceId =
              build.target.kind === 'container'
                ? build.target.containerName
                : build.target.kind === 'deployment'
                  ? build.target.deploymentId
                  : build.target.composeProjectId;
            const baseScope =
              build.target.kind === 'compose_project' ? 'docker:compose:view' : 'docker:containers:view';
            if (!hasDockerResourceScope(scopes, baseScope, nodeId, scopeResourceId)) continue;
            resolved.push({
              id: resource.id,
              nodeId,
              name: `${build.target.name} · ${build.commitSha.slice(0, 8)}`,
              state: build.status,
              kind: 'build',
              scopeBase: baseScope,
              scopeResourceId,
            });
            continue;
          }
          if (resource.kind === 'compose') {
            if (!hasDockerResourceScope(scopes, 'docker:compose:view', nodeId, resource.id)) continue;
            const project = await container
              .resolve(DockerComposeService)
              .get(nodeId, resource.id)
              .catch(() => null);
            if (!project) continue;
            resolved.push({
              id: resource.id,
              nodeId,
              name: project.name,
              state: project.status,
              kind: 'compose',
              scopeBase: 'docker:compose:view',
              scopeResourceId: project.id,
            });
            continue;
          }
          const containerData = containers.find(
            (item: any) =>
              (resource.kind === 'deployment'
                ? item.deploymentId === resource.id || item.id === resource.id
                : item.id === resource.id) || item.scopeResourceId === resource.scopeResourceId
          );
          const scopeResourceId = String(containerData?.scopeResourceId ?? '');
          if (
            containerData &&
            scopeResourceId &&
            hasDockerResourceScope(scopes, 'docker:containers:view', nodeId, scopeResourceId)
          ) {
            resolved.push({
              id: resource.kind === 'deployment' ? String(containerData.deploymentId ?? containerData.id) : resource.id,
              nodeId,
              name: String(containerData.name ?? containerData.Name ?? resource.id).replace(/^\//, ''),
              state: containerData._transition ?? containerData.state ?? containerData.State?.Status,
              kind: resource.kind,
              scopeBase: 'docker:containers:view',
              scopeResourceId,
            });
          }
        }
        return resolved;
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
    tlsRepairFailures,
    daemonUpdates,
    dockerNavigationHealth,
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
    tlsRepairFailuresPromise,
    daemonUpdatesPromise,
    dockerNavigationHealthPromise,
  ]);
  const now = Date.now();
  const nodeCardIds = nodeResponse.data
    .filter((node: any) => dashboardPinNodeIds.includes(node.id) || hasNodeCapacityWarning(node))
    .map((node: any) => node.id);
  const nodeHealthRows =
    nodeCardIds.length > 0
      ? await (container.resolve(TOKENS.DrizzleClient) as DrizzleClient)
          .select({ id: nodes.id, healthHistory: nodes.healthHistory })
          .from(nodes)
          .where(inArray(nodes.id, nodeCardIds))
      : [];
  const nodeHealthById = new Map(nodeHealthRows.map((row) => [row.id, row.healthHistory ?? []]));
  const dashboardNodes = nodeResponse.data.map((node: any) =>
    nodeHealthById.has(node.id) ? { ...node, healthHistory: nodeHealthById.get(node.id) } : node
  );
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
  const mfaGraceActive = Boolean(
    mfa &&
      !mfa.sessionMfaSatisfied &&
      typeof mfa.graceExpiresAt === 'number' &&
      Number.isFinite(mfa.graceExpiresAt) &&
      mfa.graceExpiresAt > now
  );
  const lowInference = inferenceUsage
    ? [
        inferenceUsage.api,
        inferenceUsage.subscription['5h'],
        inferenceUsage.subscription['7d'],
        inferenceUsage.subscription['30d'],
      ].some((window) => window.configured && 100 - window.percentage < 20)
    : false;
  const nodeCapacityWarning = dashboardNodes.some(hasNodeCapacityWarning);
  const nodeHealthWarning = nodeResponse.data.some((node: any) =>
    ['offline', 'error', 'degraded'].includes(node.status)
  );
  const pinnedDatabaseWarning = hasDashboardPinnedDatabaseWarning(pinnedDatabaseResponse.data, dashboardPinDatabaseIds);
  const pinnedDockerWarning = hasDashboardPinnedDockerWarning(
    pinnedDockerResources,
    request.pins.dashboard.dockerResources
  );
  const relay = container.isRegistered(RelaySupervisorService)
    ? container.resolve(RelaySupervisorService).getSnapshot(hasScope(scopes, 'admin:system'))
    : null;
  const relayNotice =
    relay?.state === 'critical'
      ? { id: 'gateway-relay', severity: 'critical' as const }
      : relay && ['migration_pending', 'maintenance', 'recovering', 'degraded'].includes(relay.state)
        ? { id: 'gateway-relay', severity: 'warning' as const }
        : null;
  const notices = [
    ...(relayNotice ? [relayNotice] : []),
    ...(tlsRepairFailures > 0 ? [{ id: 'tls-certificate-distribution', severity: 'critical' as const }] : []),
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
    ...(mfa && ((!mfaHasFactor && (mfa.required || mfa.showReminder)) || mfaGraceActive)
      ? [{ id: 'mfa', severity: 'warning' as const }]
      : []),
    ...(update?.updateAvailable ? [{ id: 'gateway-update', severity: 'warning' as const }] : []),
    ...(loggingHealth && !['disabled', 'healthy'].includes(loggingHealth.status)
      ? [{ id: 'logging-health', severity: 'warning' as const }]
      : []),
    ...(lowInference ? [{ id: 'inference-usage', severity: 'warning' as const }] : []),
    ...(finalizeSetup && !isFinalizeSetupComplete(finalizeSetup) && !(mfa && !mfaHasFactor && mfa.showReminder)
      ? [{ id: 'finalize-setup', severity: 'info' as const }]
      : []),
  ];
  const visibleNodes = new Map(dashboardNodes.map((node: any) => [node.id, node]));
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
  const visibleUpdateNodeIds = hasScope(scopes, 'nodes:details') ? null : new Set(scopedNodeIds);
  const hasPendingNodeUpdate = daemonUpdates.some((status) =>
    status.nodes.some(
      (node) => node.updateAvailable && (!visibleUpdateNodeIds || visibleUpdateNodeIds.has(node.nodeId))
    )
  );
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
      nodes: dashboardNodes,
      expiring,
      cas,
      activity,
      finalizeSetup,
      mfa,
      update,
      loggingHealth,
      inferenceUsage,
      inviteUserMethods,
      relay,
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
      navigationAttention: {
        nodes: nodeNavigationAttention(Number(stats.nodes.offline ?? 0), hasPendingNodeUpdate),
        'proxy-hosts': healthNavigationAttention(
          health.map((host) => ({ enabled: host.enabled, healthStatus: host.healthStatus }))
        ),
        docker: healthNavigationAttention(dockerNavigationHealth),
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
  const snapshot = await container.resolve(DashboardReadModelService).get<any[]>('health');
  const overview =
    snapshot && snapshot.revision > 0
      ? hasScope(scopes, 'proxy:view')
        ? snapshot.data
        : snapshot.data.filter((host) => getResourceScopedIds(scopes, 'proxy:view').includes(host.id))
      : await monitoringService.getHealthOverview(
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
