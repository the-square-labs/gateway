import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerContainerFolderAssignments } from '@/db/schema/index.js';
import { hasScopeForCreation } from '@/lib/permissions.js';
import { hasDockerResourceScope } from '../docker-access-resource.service.js';
import type { DockerAvailabilityResolvedResource } from './docker-availability.types.js';

/** The folder a workload is placed in: containers and deployments by name, Compose Projects by id. */
export async function dockerAvailabilityWorkloadFolderId(
  db: DrizzleClient,
  resource: Pick<DockerAvailabilityResolvedResource, 'kind' | 'currentNodeId' | 'displayName' | 'resourceId'>
): Promise<string | null> {
  const [assignment] = await db
    .select({ folderId: dockerContainerFolderAssignments.folderId })
    .from(dockerContainerFolderAssignments)
    .where(
      and(
        eq(dockerContainerFolderAssignments.nodeId, resource.currentNodeId),
        eq(dockerContainerFolderAssignments.resourceType, resource.kind === 'compose' ? 'compose' : 'container'),
        eq(
          dockerContainerFolderAssignments.resourceKey,
          resource.kind === 'compose' ? resource.resourceId : resource.displayName
        )
      )
    )
    .limit(1);
  return assignment?.folderId ?? null;
}

/**
 * Scopes missing to place a replica of the workload on a candidate node. Creation follows the normal destination
 * rule (broad, the candidate node, or the folder the workload stays in, so folder grants work on every Docker
 * node). The runtime scopes may be held on the candidate node as before, or on the workload itself: its replicas
 * are the same workload, so an exact grant on it (what a folder grant resolves to) counts too. A node-wide grant
 * on the current node does not stand in for the candidate node.
 */
export function missingDockerAvailabilityCandidateScopes(
  scopes: string[],
  resource: Pick<DockerAvailabilityResolvedResource, 'kind' | 'currentNodeId' | 'resourceId'>,
  nodeId: string,
  folderId: string | null
): string[] {
  const create = resource.kind === 'compose' ? 'docker:compose:create' : 'docker:containers:create';
  const runtime =
    resource.kind === 'compose'
      ? ['docker:compose:manage']
      : ['docker:containers:manage', 'docker:containers:environment', 'docker:containers:secrets'];
  const missing = hasScopeForCreation(scopes, create, folderId, nodeId) ? [] : [create];
  for (const scope of runtime) {
    if (
      !hasDockerResourceScope(scopes, scope, nodeId, resource.resourceId) &&
      !scopes.includes(`${scope}:${resource.currentNodeId}/${resource.resourceId}`)
    ) {
      missing.push(scope);
    }
  }
  return missing;
}
