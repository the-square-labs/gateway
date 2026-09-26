import { accessSummaryDatabase, accessSummaryPrincipal, buildAccessSummary } from '@/lib/access-summary-resolver.js';
import type { User } from '@/types.js';

export const ACCESS_TOOL_NAMES = new Set(['get_my_access']);

/**
 * get_my_access: the caller's access summary, bounded exactly like its tool calls. MCP callers carry
 * token-bounded scopes plus their owner's `accountScopes`; the in-product assistant runs as the user.
 */
export async function executeAccessTool(
  user: User,
  _toolName: string,
  args: Record<string, unknown>,
  source: 'ai' | 'mcp' = 'ai'
) {
  // MCP clients never receive the owner's identity; the in-product assistant runs in the user's own session.
  const mcp = source === 'mcp' || !!user.accountScopes;
  const summary = await buildAccessSummary(
    accessSummaryDatabase(),
    user.scopes,
    accessSummaryPrincipal(user, mcp ? 'mcp' : 'assistant')
  );
  const area = typeof args.area === 'string' && args.area ? args.area : null;
  if (!area) return summary;
  return { ...summary, areas: summary.areas.filter((entry) => entry.area === area) };
}
