import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerContainerFolderAssignments } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuthService } from '@/modules/auth/auth.service.js';
import { assertDockerCreationAccess } from './docker-creation-access.js';

export async function assertBuildActivationAccess(
  db: DrizzleClient,
  auth: Pick<AuthService, 'getUserById'> | undefined,
  actorId: string | null,
  nodeId: string,
  resourceKey: string,
  resourceType: 'container' | 'compose'
) {
  const actor = actorId ? await auth?.getUserById(actorId) : null;
  if (!actor || actor.isBlocked || actor.isDeleted) {
    throw new AppError(403, 'BUILD_ACTOR_FORBIDDEN', 'The build initiator no longer has access');
  }
  const [assignment] = await db
    .select({ folderId: dockerContainerFolderAssignments.folderId })
    .from(dockerContainerFolderAssignments)
    .where(
      and(
        eq(dockerContainerFolderAssignments.nodeId, nodeId),
        eq(dockerContainerFolderAssignments.resourceType, resourceType),
        eq(dockerContainerFolderAssignments.resourceKey, resourceKey)
      )
    )
    .limit(1);
  await assertDockerCreationAccess(
    db,
    actor.scopes,
    resourceType === 'compose' ? 'docker:compose:create' : 'docker:containers:create',
    nodeId,
    assignment?.folderId,
    resourceType
  );
  return actor;
}
