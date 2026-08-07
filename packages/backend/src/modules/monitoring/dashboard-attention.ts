export type DashboardAttentionSeverity = 'info' | 'warning' | 'critical';

export function getDashboardAttentionSeverity(
  notices: ReadonlyArray<{ severity: DashboardAttentionSeverity }>
): DashboardAttentionSeverity | null {
  if (notices.some((notice) => notice.severity === 'critical')) return 'critical';
  if (notices.some((notice) => notice.severity === 'warning')) return 'warning';
  return notices.length > 0 ? 'info' : null;
}
