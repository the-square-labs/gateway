export type DashboardAttentionSeverity = 'info' | 'warning' | 'critical';

const UNHEALTHY_DATABASE_STATUSES = new Set(['offline', 'degraded']);
const UNHEALTHY_DOCKER_STATUSES = new Set(['failed', 'unhealthy', 'exited', 'dead', 'stopped', 'degraded']);

export function hasDashboardPinnedDatabaseWarning(
  databases: ReadonlyArray<{ id: string; healthStatus?: string | null }>,
  dashboardPinnedIds: readonly string[]
): boolean {
  const dashboardPins = new Set(dashboardPinnedIds);
  return databases.some(
    (database) => dashboardPins.has(database.id) && UNHEALTHY_DATABASE_STATUSES.has(database.healthStatus ?? '')
  );
}

type DockerResourceIdentity = { id: string; nodeId: string; kind: string };

function dockerResourceKey(resource: DockerResourceIdentity): string {
  return `${resource.kind}:${resource.nodeId}:${resource.id}`;
}

export function hasDashboardPinnedDockerWarning(
  resources: ReadonlyArray<DockerResourceIdentity & { state?: string | null }>,
  dashboardPins: readonly DockerResourceIdentity[]
): boolean {
  const dashboardPinKeys = new Set(dashboardPins.map(dockerResourceKey));
  return resources.some(
    (resource) =>
      dashboardPinKeys.has(dockerResourceKey(resource)) &&
      UNHEALTHY_DOCKER_STATUSES.has(String(resource.state ?? '').toLowerCase())
  );
}

export function getDashboardAttentionSeverity(
  notices: ReadonlyArray<{ severity: DashboardAttentionSeverity }>
): DashboardAttentionSeverity | null {
  if (notices.some((notice) => notice.severity === 'critical')) return 'critical';
  if (notices.some((notice) => notice.severity === 'warning')) return 'warning';
  return notices.length > 0 ? 'info' : null;
}
