import { getFolderScopedIds } from '@/lib/folder-scopes.js';
import { hasScope, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';

/**
 * Ingress groups live in node folders and use node scopes: viewing needs nodes:details (broadly or on the group's
 * folder), changing needs nodes:manage (broadly or on the folder), and putting a node into a group also needs
 * nodes:manage on that node.
 */
export function canViewIngressGroup(scopes: readonly string[], folderId: string | null): boolean {
  return (
    hasScope(scopes, 'nodes:details') ||
    hasScope(scopes, 'nodes:manage') ||
    (!!folderId &&
      (hasScope(scopes, `nodes:details:folder/${folderId}`) || hasScope(scopes, `nodes:manage:folder/${folderId}`)))
  );
}

/** Folder ids whose groups a folder-limited caller may view; null means every group. */
export function viewableIngressGroupFolderIds(scopes: readonly string[]): string[] | null {
  if (hasScope(scopes, 'nodes:details') || hasScope(scopes, 'nodes:manage')) return null;
  return getFolderScopedIds(scopes, ['nodes:details', 'nodes:manage']);
}

export function assertCanManageIngressGroup(scopes: readonly string[], folderId: string | null): void {
  if (hasScopeForCreation(scopes, 'nodes:manage', folderId)) return;
  throw new AppError(403, 'FORBIDDEN', 'Managing this ingress group requires nodes:manage', {
    requiredScope: folderId ? `nodes:manage:folder/${folderId}` : 'nodes:manage',
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
