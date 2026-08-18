import { getResourceScopedIds, hasScope, hasScopeForResource } from '@/lib/permissions.js';

export function visiblePageProjectIds(scopes: readonly string[]): string[] | undefined {
  const mutableScopes = [...scopes];
  return hasScope(mutableScopes, 'pages:view') ? undefined : getResourceScopedIds(scopes, 'pages:view');
}

export function canAccessPageProject(scopes: readonly string[], baseScope: string, projectId: string): boolean {
  return hasScopeForResource([...scopes], baseScope, projectId);
}

export function canAccessEveryPageProject(
  scopes: readonly string[],
  baseScope: string,
  projectIds: readonly string[]
): boolean {
  return projectIds.every((projectId) => canAccessPageProject(scopes, baseScope, projectId));
}
