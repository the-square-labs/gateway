import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import { hasScope, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';

export const INGRESS_GROUP_VIEW_SCOPE = 'ingress:groups:view';
export const INGRESS_GROUP_MANAGE_SCOPE = 'ingress:groups:manage';

/**
 * Ingress groups live in node folders and have their own scopes, broad or limited to a node folder: viewing needs
 * ingress:groups:view (ingress:groups:manage implies it), changing needs ingress:groups:manage (broadly or on the
 * group's folder), and putting a node into a group also needs nodes:manage on that node.
 */
export function canViewIngressGroup(scopes: readonly string[], folderId: string | null): boolean {
  return (
    hasScope(scopes, INGRESS_GROUP_VIEW_SCOPE) ||
    (!!folderId && hasScope(scopes, `${INGRESS_GROUP_VIEW_SCOPE}:folder/${folderId}`))
  );
}

/** Folder ids whose groups a folder-limited caller may view; null means every group. */
export function viewableIngressGroupFolderIds(scopes: readonly string[]): string[] | null {
  if (hasScope(scopes, INGRESS_GROUP_VIEW_SCOPE)) return null;
  return getFolderScopedIds(scopes, [INGRESS_GROUP_VIEW_SCOPE, INGRESS_GROUP_MANAGE_SCOPE]);
}

/**
 * Placing a route or domain on a group needs view of the group: the route and domain pickers offer only the groups
 * the caller may view, and every other way to place something on a group is held to the same rule.
 */
export function assertCanPlaceOnGroup(scopes: readonly string[], folderId: string | null): void {
  if (canViewIngressGroup(scopes, folderId)) return;
  throw new AppError(403, 'FORBIDDEN', `Placing on this ingress group requires ${INGRESS_GROUP_VIEW_SCOPE}`, {
    requiredScope: INGRESS_GROUP_VIEW_SCOPE,
  });
}

export function assertCanManageIngressGroup(scopes: readonly string[], folderId: string | null): void {
  if (hasScopeForCreation(scopes, INGRESS_GROUP_MANAGE_SCOPE, folderId)) return;
  throw new AppError(403, 'FORBIDDEN', `Managing this ingress group requires ${INGRESS_GROUP_MANAGE_SCOPE}`, {
    requiredScope: folderId ? `${INGRESS_GROUP_MANAGE_SCOPE}:folder/${folderId}` : INGRESS_GROUP_MANAGE_SCOPE,
  });
}

export function assertCanManageMemberNode(scopes: readonly string[], nodeId: string): void {
  if (hasScope(scopes, 'nodes:manage') || hasScope(scopes, `nodes:manage:${nodeId}`)) return;
  throw new AppError(403, 'FORBIDDEN', 'Adding a node to an ingress group requires nodes:manage on that node', {
    requiredScope: `nodes:manage:${nodeId}`,
  });
}

/**
 * Placing a route or domain on a group places it on every member: the destination grant (broad, folder or node)
 * must cover each of them.
 */
export function assertCanPlaceOnMembers(
  scopes: readonly string[],
  baseScope: 'proxy:create' | 'domains:create',
  folderId: string | null | undefined,
  memberNodeIds: readonly string[]
): void {
  const missing = memberNodeIds.filter((nodeId) => !hasScopeForCreation(scopes, baseScope, folderId ?? null, nodeId));
  if (missing.length === 0) return;
  throw new AppError(
    403,
    'FORBIDDEN',
    `Missing ${baseScope} permission for ingress group member(s) ${missing.join(', ')}`,
    { requiredScope: `${baseScope}:node/${missing[0]}`, nodeIds: missing }
  );
}
