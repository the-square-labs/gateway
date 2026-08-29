import { api } from "@/services/api";
import type { DatabaseConnection, DatabaseMetricSnapshot } from "@/types";

interface DatabaseMonitoringCache {
  history: DatabaseMetricSnapshot[];
  healthHistory: DatabaseConnection["healthHistory"];
  healthStatus: DatabaseConnection["healthStatus"];
}

export function hasDatabaseScope(
  hasScope: (scope: string) => boolean,
  scope: string,
  databaseId?: string
) {
  return !!(databaseId && (hasScope(scope) || hasScope(`${scope}:${databaseId}`)));
}

export function isPrivateManagedDatabase(database: DatabaseConnection) {
  return database.managed !== undefined && database.managed.publishedPort === null;
}

export function shouldRefreshDatabaseDetailForEvent(action?: string) {
  return (
    action !== "data.updated" && action !== "query.executed" && action !== "extensions.updated"
  );
}

export function databaseMonitoringCacheKey(databaseId: string) {
  return `database:monitoring:${databaseId}`;
}

export function appendDatabaseMetricSnapshot(
  history: DatabaseMetricSnapshot[],
  snapshot: DatabaseMetricSnapshot
) {
  return [...history, snapshot].slice(-60);
}

export function readDatabaseMonitoringCache(databaseId: string | undefined) {
  return databaseId
    ? api.getCached<DatabaseMonitoringCache>(
        databaseMonitoringCacheKey(databaseId),
        Number.POSITIVE_INFINITY
      )
    : undefined;
}

export function updateDatabaseMonitoringCache(
  databaseId: string,
  update: Partial<DatabaseMonitoringCache>
) {
  const current = readDatabaseMonitoringCache(databaseId);
  api.setCache(databaseMonitoringCacheKey(databaseId), {
    history: [],
    healthHistory: [],
    healthStatus: "unknown",
    ...current,
    ...update,
  } satisfies DatabaseMonitoringCache);
}
