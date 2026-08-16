import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  databaseConnectionFolders,
  databaseConnections,
  dockerAccessResources,
  dockerContainerFolderAssignments,
  dockerContainerFolders,
  dockerDeployments,
  domainFolders,
  domains,
  loggingEnvironmentFolders,
  loggingEnvironments,
  loggingSchemaFolders,
  loggingSchemas,
  nodeFolders,
  nodes,
  proxyHostFolders,
  proxyHosts,
} from '@/db/schema/index.js';
import { canonicalizeScopes, extractBaseScope, FOLDER_SCOPABLE } from './scopes.js';

export const FOLDER_SCOPE_TARGET_PREFIX = 'folder/';

const FOLDER_SCOPABLE_SET = new Set(FOLDER_SCOPABLE);

export interface FolderScopedGrant {
  scope: string;
  baseScope: string;
  folderId: string;
}

export function folderScopeTarget(folderId: string): string {
  return `${FOLDER_SCOPE_TARGET_PREFIX}${folderId}`;
}

export function folderScopedScope(baseScope: string, folderId: string): string {
  return `${baseScope}:${folderScopeTarget(folderId)}`;
}

export function parseFolderScopedGrant(scope: string): FolderScopedGrant | null {
  const baseScope = extractBaseScope(scope);
  if (!FOLDER_SCOPABLE_SET.has(baseScope) || scope === baseScope) return null;
  const target = scope.slice(baseScope.length + 1);
  if (!target.startsWith(FOLDER_SCOPE_TARGET_PREFIX)) return null;
  const folderId = target.slice(FOLDER_SCOPE_TARGET_PREFIX.length);
  if (!folderId || folderId.includes('/')) return null;
  return { scope, baseScope, folderId };
}

export function isFolderScopedScope(scope: string): boolean {
  return parseFolderScopedGrant(scope) !== null;
}

type FolderRow = { id: string; parentId: string | null };
type ResourceRow = { id: string; folderId: string | null };

function folderDescendants(rows: FolderRow[], rootId: string): Set<string> {
  const result = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!row.parentId || !result.has(row.parentId) || result.has(row.id)) continue;
      result.add(row.id);
      changed = true;
    }
  }
  return result;
}

async function expandSimpleFamily(
  db: DrizzleClient,
  grants: FolderScopedGrant[],
  folderTable: any,
  resourceTable: any
): Promise<string[]> {
  if (grants.length === 0) return [];
  const folderRows = (await db
    .select({ id: folderTable.id, parentId: folderTable.parentId })
    .from(folderTable)) as FolderRow[];
  const descendantsByGrant = new Map(
    grants.map((grant) => [grant.scope, folderDescendants(folderRows, grant.folderId)])
  );
  const visibleFolderIds = new Set([...descendantsByGrant.values()].flatMap((ids) => [...ids]));
  if (visibleFolderIds.size === 0) return [];
  const resourceRows = (await db
    .select({ id: resourceTable.id, folderId: resourceTable.folderId })
    .from(resourceTable)
    .where(inArray(resourceTable.folderId, [...visibleFolderIds]))) as ResourceRow[];

  return grants.flatMap((grant) => {
    const folderIds = descendantsByGrant.get(grant.scope)!;
    return [
      ...[...folderIds].map((folderId) => folderScopedScope(grant.baseScope, folderId)),
      ...resourceRows
        .filter((resource) => resource.folderId && folderIds.has(resource.folderId))
        .map((resource) => `${grant.baseScope}:${resource.id}`),
    ];
  });
}

async function expandDockerFamily(db: DrizzleClient, grants: FolderScopedGrant[]): Promise<string[]> {
  if (grants.length === 0) return [];
  const folderRows = await db
    .select({
      id: dockerContainerFolders.id,
      parentId: dockerContainerFolders.parentId,
      resourceType: dockerContainerFolders.resourceType,
    })
    .from(dockerContainerFolders);
  const descendantsByGrant = new Map(
    grants.map((grant) => [grant.scope, folderDescendants(folderRows, grant.folderId)])
  );
  const visibleFolderIds = new Set([...descendantsByGrant.values()].flatMap((ids) => [...ids]));
  if (visibleFolderIds.size === 0) return [];

  const assignments = await db
    .select({
      folderId: dockerContainerFolderAssignments.folderId,
      nodeId: dockerContainerFolderAssignments.nodeId,
      resourceType: dockerContainerFolderAssignments.resourceType,
      resourceKey: dockerContainerFolderAssignments.resourceKey,
    })
    .from(dockerContainerFolderAssignments)
    .where(inArray(dockerContainerFolderAssignments.folderId, [...visibleFolderIds]));
  const containerAssignments = assignments.filter((assignment) => assignment.resourceType === 'container');
  const assignmentNodeIds = [...new Set(containerAssignments.map((assignment) => assignment.nodeId))];
  const [containerResourceIds, deploymentIds] =
    assignmentNodeIds.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({
              id: dockerAccessResources.id,
              nodeId: dockerAccessResources.nodeId,
              resourceKey: dockerAccessResources.resourceKey,
            })
            .from(dockerAccessResources)
            .where(
              and(
                eq(dockerAccessResources.resourceType, 'container'),
                inArray(dockerAccessResources.nodeId, assignmentNodeIds)
              )
            ),
          db
            .select({
              id: dockerDeployments.id,
              nodeId: dockerDeployments.nodeId,
              name: dockerDeployments.name,
            })
            .from(dockerDeployments)
            .where(inArray(dockerDeployments.nodeId, assignmentNodeIds)),
        ]);
  const containerIdByRef = new Map(
    containerResourceIds.map((resource) => [`${resource.nodeId}\u0000${resource.resourceKey}`, resource.id])
  );
  const deploymentIdByRef = new Map(
    deploymentIds.map((deployment) => [`${deployment.nodeId}\u0000${deployment.name}`, deployment.id])
  );

  return grants.flatMap((grant) => {
    const folderIds = descendantsByGrant.get(grant.scope)!;
    return [
      ...[...folderIds].map((folderId) => folderScopedScope(grant.baseScope, folderId)),
      ...assignments.flatMap((assignment) => {
        if (!assignment.folderId || !folderIds.has(assignment.folderId)) return [];
        const ref = `${assignment.nodeId}\u0000${assignment.resourceKey}`;
        const resourceId = deploymentIdByRef.get(ref) ?? containerIdByRef.get(ref);
        return resourceId ? [`${grant.baseScope}:${assignment.nodeId}/${resourceId}`] : [];
      }),
    ];
  });
}

function familyForBaseScope(baseScope: string) {
  if (baseScope.startsWith('domains:')) return 'domains';
  if (baseScope.startsWith('proxy:')) return 'proxy';
  if (baseScope.startsWith('nodes:')) return 'nodes';
  if (baseScope.startsWith('docker:containers:')) return 'docker';
  if (baseScope.startsWith('databases:')) return 'databases';
  if (baseScope.startsWith('logs:schemas:')) return 'logging-schemas';
  if (baseScope.startsWith('logs:environments:') || baseScope === 'logs:read') return 'logging-environments';
  return null;
}

/**
 * Resolve dynamic folder grants to the existing resource-scoped representation.
 * The original folder grants remain present so delegation and the permissions UI
 * retain their stable folder identity.
 */
export async function expandFolderScopes(db: DrizzleClient, scopes: readonly string[]): Promise<string[]> {
  const canonical = canonicalizeScopes(scopes);
  const grants = canonical.flatMap((scope) => {
    const parsed = parseFolderScopedGrant(scope);
    return parsed ? [parsed] : [];
  });
  if (grants.length === 0) return canonical;

  const byFamily = new Map<string, FolderScopedGrant[]>();
  for (const grant of grants) {
    const family = familyForBaseScope(grant.baseScope);
    if (!family) continue;
    byFamily.set(family, [...(byFamily.get(family) ?? []), grant]);
  }

  const expanded = await Promise.all([
    expandSimpleFamily(db, byFamily.get('domains') ?? [], domainFolders, domains),
    expandSimpleFamily(db, byFamily.get('proxy') ?? [], proxyHostFolders, proxyHosts),
    expandSimpleFamily(db, byFamily.get('nodes') ?? [], nodeFolders, nodes),
    expandDockerFamily(db, byFamily.get('docker') ?? []),
    expandSimpleFamily(db, byFamily.get('databases') ?? [], databaseConnectionFolders, databaseConnections),
    expandSimpleFamily(db, byFamily.get('logging-environments') ?? [], loggingEnvironmentFolders, loggingEnvironments),
    expandSimpleFamily(db, byFamily.get('logging-schemas') ?? [], loggingSchemaFolders, loggingSchemas),
  ]);

  return canonicalizeScopes([...canonical, ...expanded.flat()]);
}
