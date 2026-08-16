export type NavigationAttentionSeverity = 'warning' | 'critical' | null;

export function healthNavigationAttention(
  rows: Array<{ enabled?: boolean; healthStatus?: unknown }>
): NavigationAttentionSeverity {
  const enabledRows = rows.filter((row) => row.enabled !== false);
  if (enabledRows.some((row) => row.healthStatus === 'offline')) return 'critical';
  if (enabledRows.some((row) => row.healthStatus === 'degraded')) return 'warning';
  return null;
}

export function nodeNavigationAttention(offlineCount: number, hasPendingUpdates: boolean): NavigationAttentionSeverity {
  if (offlineCount > 0) return 'critical';
  if (hasPendingUpdates) return 'warning';
  return null;
}
