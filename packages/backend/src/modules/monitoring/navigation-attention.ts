export type NavigationAttentionSeverity = 'warning' | 'critical' | null;

export function healthNavigationAttention(
  rows: Array<{ enabled?: boolean; healthStatus?: unknown }>
): NavigationAttentionSeverity {
  const enabledRows = rows.filter((row) => row.enabled !== false);
  if (enabledRows.some((row) => row.healthStatus === 'offline')) return 'critical';
  if (enabledRows.some((row) => row.healthStatus === 'degraded')) return 'warning';
  return null;
}

export function nodeNavigationAttention(
  nodes: Array<{ id: string; status?: unknown }>,
  updateNodeIds: ReadonlySet<string>
): NavigationAttentionSeverity {
  if (nodes.some((node) => node.status === 'offline')) return 'critical';
  if (nodes.some((node) => updateNodeIds.has(node.id))) return 'warning';
  return null;
}
