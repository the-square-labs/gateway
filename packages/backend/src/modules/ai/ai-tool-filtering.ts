import { getResourceScopedIds, hasScope, hasScopeBase } from '@/lib/permissions.js';
import {
  AI_TOOL_ANY_SCOPE_REQUIREMENTS as ANY_SCOPE_TOOL_REQUIREMENTS,
  AI_BROAD_ONLY_TOOL_SCOPES as BROAD_ONLY_TOOL_SCOPES,
  AI_DIRECT_DATABASE_VIEW_AND_QUERY_TOOLS as DIRECT_DATABASE_VIEW_AND_QUERY_TOOLS,
  AI_DIRECT_DATABASE_VIEW_TOOLS as DIRECT_DATABASE_VIEW_TOOLS,
} from './ai-tool-scope-policy.js';

function hasDirectScopeBase(userScopes: string[], requiredScope: string): boolean {
  return userScopes.includes(requiredScope) || userScopes.some((scope) => scope.startsWith(`${requiredScope}:`));
}

function getDirectResourceScopedIds(userScopes: string[], baseScope: string): string[] {
  return userScopes
    .filter((scope) => scope.startsWith(`${baseScope}:`) && scope.length > baseScope.length + 1)
    .map((scope) => scope.slice(baseScope.length + 1));
}

function hasDirectDatabaseViewForQueryTool(userScopes: string[], queryScope: string): boolean {
  if (!hasScopeBase(userScopes, queryScope) || !hasDirectScopeBase(userScopes, 'databases:view')) return false;
  if (userScopes.includes('databases:view') || hasScope(userScopes, queryScope)) return true;

  const queryIds = new Set(getResourceScopedIds(userScopes, queryScope));
  return getDirectResourceScopedIds(userScopes, 'databases:view').some((databaseId) => queryIds.has(databaseId));
}

function hasAnyRequiredToolScope(userScopes: string[], toolName: string): boolean {
  const requirements = ANY_SCOPE_TOOL_REQUIREMENTS[toolName];
  return !!requirements && requirements.some((scope) => hasScopeBase(userScopes, scope));
}

export function canUseAiTool(
  toolName: string,
  requiredScope: string | undefined,
  userScopes: string[],
  requiredScopes: string[] = []
) {
  if (!requiredScope) return false;
  if (!requiredScopes.every((scope) => hasScopeBase(userScopes, scope))) return false;
  if (DIRECT_DATABASE_VIEW_AND_QUERY_TOOLS.has(toolName)) {
    return hasDirectDatabaseViewForQueryTool(userScopes, requiredScope);
  }
  if (ANY_SCOPE_TOOL_REQUIREMENTS[toolName]) return hasAnyRequiredToolScope(userScopes, toolName);
  if (DIRECT_DATABASE_VIEW_TOOLS.has(toolName)) return hasDirectScopeBase(userScopes, requiredScope);
  return BROAD_ONLY_TOOL_SCOPES.has(toolName)
    ? hasScope(userScopes, requiredScope)
    : hasScopeBase(userScopes, requiredScope);
}
