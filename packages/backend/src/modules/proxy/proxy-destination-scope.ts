import { hasScope } from '@/lib/permissions.js';

/**
 * Destination-scoped proxy permissions for a route that does not exist yet (or is being moved): a broad grant, a
 * grant on the destination folder, or a grant on the destination ingress node. A route on an ingress group is
 * created on every member, so a node grant must cover each of them. Shared by the REST routes and the AI/MCP tools.
 */
export function hasProxyDestinationScope(
  scopes: readonly string[],
  baseScope: string,
  folderId: string | null | undefined,
  nodeId: string | null | undefined | readonly string[]
): boolean {
  if (hasScope(scopes, baseScope)) return true;
  if (folderId && !folderId.includes('/') && hasScope(scopes, `${baseScope}:folder/${folderId}`)) return true;
  const nodeIds: readonly string[] = Array.isArray(nodeId) ? nodeId : nodeId ? [nodeId as string] : [];
  return nodeIds.length > 0 && nodeIds.every((id) => !id.includes('/') && hasScope(scopes, `${baseScope}:node/${id}`));
}
