export type DashboardAttentionSeverity = 'info' | 'warning' | 'critical';

/**
 * One reason for the sidebar Dashboard dot. The Dashboard renders its explanation from this list, so a
 * notice may name what it is about: `ids` (nodes, routes, pinned resources, inference windows) or
 * `count` (certificates).
 */
export interface DashboardAttentionNotice {
  id: string;
  severity: DashboardAttentionSeverity;
  ids?: string[];
  count?: number;
}

// The rules below are mirrored by packages/frontend/src/lib/dashboard-attention.ts, which draws the
// Dashboard. dashboard-attention.test.ts runs both over the same cases.

/** CPU, memory, or root disk usage at or above this percentage puts a node card on the Dashboard. */
export const NODE_CAPACITY_WARNING_PERCENT = 80;

type NodeCapacityHealth = {
  cpuPercent?: number | null;
  systemMemoryTotalBytes?: number | null;
  systemMemoryUsedBytes?: number | null;
  diskMounts?: ReadonlyArray<{ mountPoint: string; usagePercent?: number | null }> | null;
};

export function nodeCapacityWarnings(health: NodeCapacityHealth | null | undefined): {
  cpu: boolean;
  memory: boolean;
  disk: boolean;
} {
  if (!health) return { cpu: false, memory: false, disk: false };
  const memoryTotal = Number(health.systemMemoryTotalBytes ?? 0);
  const memory = memoryTotal > 0 ? (Number(health.systemMemoryUsedBytes ?? 0) / memoryTotal) * 100 : 0;
  const disk = health.diskMounts?.find((mount) => mount.mountPoint === '/');
  return {
    cpu: Number(health.cpuPercent ?? 0) >= NODE_CAPACITY_WARNING_PERCENT,
    memory: memory >= NODE_CAPACITY_WARNING_PERCENT,
    disk: Number(disk?.usagePercent ?? 0) >= NODE_CAPACITY_WARNING_PERCENT,
  };
}

export function hasNodeCapacityWarning(node: { lastHealthReport?: NodeCapacityHealth | null }): boolean {
  const warnings = nodeCapacityWarnings(node.lastHealthReport);
  return warnings.cpu || warnings.memory || warnings.disk;
}

const NODE_FLAP_WINDOW_MS = 5 * 60 * 1000;

/** An online node that went offline or degraded in the last five minutes shows as degraded. */
export function effectiveNodeStatus(
  node: { status: string; healthHistory?: ReadonlyArray<{ ts: string; status: string }> | null },
  now: number
): string {
  if (node.status !== 'online' || !node.healthHistory?.length) return node.status;
  const since = now - NODE_FLAP_WINDOW_MS;
  const recent = node.healthHistory.filter((entry) => entry.ts && new Date(entry.ts).getTime() >= since);
  if (recent.some((entry) => entry.status === 'offline' || entry.status === 'degraded')) return 'degraded';
  return 'online';
}

const UNHEALTHY_NODE_STATUSES = new Set(['offline', 'error', 'degraded']);

/** Nodes the Dashboard shows as offline, error, or degraded. */
export function nodeHealthAttentionIds(
  nodes: ReadonlyArray<{
    id: string;
    status: string;
    healthHistory?: ReadonlyArray<{ ts: string; status: string }> | null;
  }>,
  now: number
): string[] {
  return nodes.filter((node) => UNHEALTHY_NODE_STATUSES.has(effectiveNodeStatus(node, now))).map((node) => node.id);
}

const UNHEALTHY_PROXY_STATUSES = new Set(['offline', 'degraded', 'recovering']);

/** Routes the Dashboard shows as offline, degraded, or recovering: the health list and dashboard pins. */
export function proxyHealthAttentionIds(
  health: ReadonlyArray<{ id: string; healthStatus?: string | null; effectiveHealthStatus?: string | null }>,
  dashboardPinnedProxies: ReadonlyArray<{
    id: string;
    healthStatus?: string | null;
    effectiveHealthStatus?: string | null;
  }>
): string[] {
  const ids = new Set<string>();
  for (const host of [...health, ...dashboardPinnedProxies]) {
    if (UNHEALTHY_PROXY_STATUSES.has(host.effectiveHealthStatus ?? host.healthStatus ?? '')) ids.add(host.id);
  }
  return [...ids];
}

const UNHEALTHY_DATABASE_STATUSES = new Set(['offline', 'degraded']);
const UNHEALTHY_DOCKER_STATUSES = new Set(['failed', 'unhealthy', 'exited', 'dead', 'stopped', 'degraded']);

export function dashboardPinnedDatabaseWarningIds(
  databases: ReadonlyArray<{ id: string; healthStatus?: string | null }>,
  dashboardPinnedIds: readonly string[]
): string[] {
  const dashboardPins = new Set(dashboardPinnedIds);
  return databases
    .filter(
      (database) => dashboardPins.has(database.id) && UNHEALTHY_DATABASE_STATUSES.has(database.healthStatus ?? '')
    )
    .map((database) => database.id);
}

type DockerResourceIdentity = { id: string; nodeId: string; kind: string };

export function dockerResourceKey(resource: DockerResourceIdentity): string {
  return `${resource.kind}:${resource.nodeId}:${resource.id}`;
}

/** Keys (`kind:nodeId:id`) of the dashboard-pinned Docker resources in a failed or stopped state. */
export function dashboardPinnedDockerWarningKeys(
  resources: ReadonlyArray<DockerResourceIdentity & { state?: string | null }>,
  dashboardPins: readonly DockerResourceIdentity[]
): string[] {
  const dashboardPinKeys = new Set(dashboardPins.map(dockerResourceKey));
  return resources
    .filter(
      (resource) =>
        dashboardPinKeys.has(dockerResourceKey(resource)) &&
        UNHEALTHY_DOCKER_STATUSES.has(String(resource.state ?? '').toLowerCase())
    )
    .map(dockerResourceKey);
}

/** The Dashboard warns when less than this percentage of an inference quota window remains. */
export const INFERENCE_USAGE_WARNING_REMAINING_PERCENT = 20;

export type InferenceUsageWindowId = 'api' | '5h' | '7d' | '30d';

type InferenceWindow = { configured: boolean; active?: boolean; percentage: number };

/**
 * Quota windows running low. A lazy window that has not started yet (`active: false`) holds no usage
 * and is never low.
 */
export function lowInferenceUsageWindows(
  usage: {
    enabled: boolean;
    api: InferenceWindow;
    subscription: Record<'5h' | '7d' | '30d', InferenceWindow>;
  } | null
): InferenceUsageWindowId[] {
  if (!usage?.enabled) return [];
  const windows: Array<[InferenceUsageWindowId, InferenceWindow]> = [
    ['api', usage.api],
    ['5h', usage.subscription['5h']],
    ['7d', usage.subscription['7d']],
    ['30d', usage.subscription['30d']],
  ];
  return windows
    .filter(([, window]) => {
      if (!window.configured || window.active === false) return false;
      const remaining = Math.max(0, Math.min(100, 100 - window.percentage));
      return remaining < INFERENCE_USAGE_WARNING_REMAINING_PERCENT;
    })
    .map(([id]) => id);
}

export function getDashboardAttentionSeverity(
  notices: ReadonlyArray<{ severity: DashboardAttentionSeverity }>
): DashboardAttentionSeverity | null {
  if (notices.some((notice) => notice.severity === 'critical')) return 'critical';
  if (notices.some((notice) => notice.severity === 'warning')) return 'warning';
  return notices.length > 0 ? 'info' : null;
}
