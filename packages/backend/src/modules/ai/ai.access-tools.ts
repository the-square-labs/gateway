import { accessSummaryDatabase, buildAccessSummary } from '@/lib/access-summary-resolver.js';
import type { User } from '@/types.js';

export const ACCESS_TOOL_NAMES = new Set(['get_my_access']);

/**
 * get_my_access: the caller's access summary, bounded exactly like its tool calls. MCP callers carry
 * token-bounded scopes plus their owner's `accountScopes`; the in-product assistant runs as the user.
 */
export async function executeAccessTool(user: User, _toolName: string, args: Record<string, unknown>) {
  const summary = await buildAccessSummary(accessSummaryDatabase(), user.scopes, {
    userId: user.id,
    name: user.name,
    email: user.email,
    group: user.groupName,
    credential: user.accountScopes ? 'mcp' : 'assistant',
    boundedByOwner: !!user.accountScopes,
  });
  const area = typeof args.area === 'string' && args.area ? args.area : null;
  if (!area) return summary;
  return { ...summary, areas: summary.areas.filter((entry) => entry.area === area) };
}
