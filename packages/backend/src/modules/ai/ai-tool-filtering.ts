import { hasAIToolVisibilityScope } from './ai-tool-scope-policy.js';

/** Whether the assistant may offer a tool to these scopes; the same rule decides MCP tools/list. */
export function canUseAiTool(
  toolName: string,
  requiredScope: string | undefined,
  userScopes: string[],
  requiredScopes: string[] = []
) {
  if (!requiredScope) return false;
  return hasAIToolVisibilityScope(userScopes, {
    name: toolName,
    requiredScope,
    requiredScopes: requiredScopes.length > 0 ? requiredScopes : undefined,
  });
}
