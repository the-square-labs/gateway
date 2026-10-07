/**
 * Ingress groups used node scopes before they got their own (`ingress:groups:view`, `ingress:groups:manage`).
 * Migration 0228 gave every stored grant that could see or change ingress groups the new scopes; this is the same
 * rule for the startup repair after a rollback (see startup-scope-sync.ts).
 *
 * Broad and folder grants carry over with their qualifier: `nodes:details` adds view, `nodes:manage` adds view and
 * manage. Node grants (`nodes:*:<nodeId>`) never covered a group and add nothing.
 */
export const INGRESS_GROUP_SCOPE_SOURCES: Readonly<Record<string, readonly string[]>> = {
  'nodes:details': ['ingress:groups:view'],
  'nodes:manage': ['ingress:groups:view', 'ingress:groups:manage'],
};

const FOLDER_QUALIFIER = ':folder/';

function mirroredScopes(scope: string): string[] {
  for (const [source, mirrored] of Object.entries(INGRESS_GROUP_SCOPE_SOURCES)) {
    if (scope === source) return [...mirrored];
    const prefix = `${source}${FOLDER_QUALIFIER}`;
    if (!scope.startsWith(prefix)) continue;
    const folderId = scope.slice(prefix.length);
    if (!folderId || folderId.includes('/')) return [];
    return mirrored.map((target) => `${target}${FOLDER_QUALIFIER}${folderId}`);
  }
  return [];
}

/** A stored scope list with the ingress group scopes its node grants imply added; nothing is removed or reordered. */
export function withIngressGroupScopes(scopes: readonly string[]): string[] {
  return [...new Set([...scopes, ...scopes.flatMap((scope) => mirroredScopes(scope.trim()))])];
}
