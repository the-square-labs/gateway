export type DashboardAttentionSeverity = 'info' | 'warning';

export function getDashboardAttentionSeverity(
  notices: ReadonlyArray<{ severity: DashboardAttentionSeverity }>
): DashboardAttentionSeverity | null {
  if (notices.some((notice) => notice.severity === 'warning')) return 'warning';
  return notices.length > 0 ? 'info' : null;
}
