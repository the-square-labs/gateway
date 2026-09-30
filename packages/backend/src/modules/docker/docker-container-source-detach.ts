import { and, eq } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { dockerSourceBindings } from '@/db/schema/index.js';
import { DockerSourceService } from './docker-source.service.js';

function containerBinding(nodeId: string, containerName: string) {
  return and(
    eq(dockerSourceBindings.targetKind, 'container'),
    eq(dockerSourceBindings.nodeId, nodeId),
    eq(dockerSourceBindings.containerName, containerName)
  );
}

function commercialModuleMissing(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'COMMERCIAL_MODULE_UNAVAILABLE';
}

/**
 * Detach the Git source of a container that no longer exists. The commercial
 * source service also removes the provider webhook; the host stub cannot, so
 * without the commercial module the binding row is deleted directly.
 *
 * When the service keeps the binding (its webhook could not be removed yet),
 * auto-build and auto-deploy are switched off so a new commit cannot recreate
 * the removed container, and the service error is rethrown. The orphan repair
 * retries the removal later.
 */
export async function detachRemovedContainerSource(
  db: DrizzleClient,
  nodeId: string,
  containerName: string,
  userId: string
): Promise<void> {
  if (container.isRegistered(DockerSourceService)) {
    try {
      await container.resolve(DockerSourceService).remove({ kind: 'container', nodeId, containerName }, userId);
      return;
    } catch (error) {
      if (!commercialModuleMissing(error)) {
        await db
          .update(dockerSourceBindings)
          .set({ autoBuild: false, autoDeploy: false, updatedAt: new Date() })
          .where(containerBinding(nodeId, containerName));
        throw error;
      }
    }
  }
  await db.delete(dockerSourceBindings).where(containerBinding(nodeId, containerName));
}
