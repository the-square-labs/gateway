import { and, eq } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { dockerContainerFolderAssignments, dockerContainerFolders } from '@/db/schema/index.js';
import { hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { DockerFolderResourceType } from './docker-folder.schemas.js';

export async function assertDockerCreationAccess(
  db: DrizzleClient,
  scopes: readonly string[],
  baseScope: string,
  nodeId: string,
  folderId: unknown,
  resourceType: DockerFolderResourceType = 'container'
): Promise<void> {
  if (folderId !== undefined && folderId !== null && typeof folderId !== 'string') {
    throw new AppError(400, 'INVALID_FOLDER', 'Invalid destination folder');
  }
  if (!hasScopeForCreation(scopes, baseScope, folderId, nodeId)) {
    throw new AppError(403, 'FORBIDDEN', `Missing ${baseScope} for the destination node or folder`);
  }
  if (!folderId) return;
  const [folder] = await db
    .select({ id: dockerContainerFolders.id, isSystem: dockerContainerFolders.isSystem })
    .from(dockerContainerFolders)
    .where(and(eq(dockerContainerFolders.id, folderId), eq(dockerContainerFolders.resourceType, resourceType)))
    .limit(1);
  if (!folder || folder.isSystem) throw new AppError(403, 'FOLDER_FORBIDDEN', 'Destination folder is unavailable');
}

/** Assign the already-authorized destination before the created entity is published. */
export async function placeCreatedDockerResource(
  db: DrizzleExecutor,
  nodeId: string,
  resourceType: DockerFolderResourceType,
  resourceKey: string,
  folderId: string | null | undefined
) {
  if (!folderId) return;
  await db
    .insert(dockerContainerFolderAssignments)
    .values({ nodeId, resourceType, resourceKey, folderId })
    .onConflictDoUpdate({
      target: [
        dockerContainerFolderAssignments.nodeId,
        dockerContainerFolderAssignments.resourceType,
        dockerContainerFolderAssignments.resourceKey,
      ],
      set: { folderId },
    });
}
