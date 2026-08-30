import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import {
  filterGatewayInternalImages,
  isDanglingDockerImage,
  isGatewayInternalImage,
} from './docker-internal-images.js';
import type { DockerRegistryService } from './docker-registry.service.js';
import type { DockerTaskService } from './docker-task.service.js';

type DockerDispatchResult = { success: boolean; error?: string; detail?: string };

export interface DockerImageOperationContext {
  nodeDispatch: NodeDispatchService;
  auditService: AuditService;
  taskService?: DockerTaskService;
  registryService?: DockerRegistryService;
  eventBus?: EventBusService;
  parseResult(result: DockerDispatchResult): unknown;
  createTask(
    nodeId: string,
    containerId: string,
    containerName: string,
    type: string
  ): Promise<{ id: string } | undefined>;
  longDockerOperationTimeoutMs: number;
}

export async function listAllImages(context: DockerImageOperationContext, nodeId: string) {
  const result = await context.nodeDispatch.sendDockerImageCommand(nodeId, 'list');
  return context.parseResult(result);
}

export async function listImages(context: DockerImageOperationContext, nodeId: string) {
  const images = await listAllImages(context, nodeId);
  return Array.isArray(images) ? filterGatewayInternalImages(images) : images;
}

export async function pullImage(
  context: DockerImageOperationContext,
  nodeId: string,
  imageRef: string,
  registryAuth?: string,
  userId?: string,
  registryId?: string
) {
  const task = await context.createTask(nodeId, '', imageRef, 'pull');
  if (userId) {
    await context.auditService.log({
      action: 'docker.image.pull',
      userId,
      resourceType: 'docker-image',
      details: { nodeId, imageRef },
    });
  }

  context.nodeDispatch
    .sendDockerImageCommand(
      nodeId,
      'pull',
      { imageRef, registryAuthJson: registryAuth },
      context.longDockerOperationTimeoutMs
    )
    .then(async (result) => {
      try {
        context.parseResult(result);
      } catch (err) {
        if (task?.id && context.taskService) {
          context.taskService
            .update(task.id, {
              status: 'failed',
              error: err instanceof Error ? err.message : 'Pull failed',
              completedAt: new Date(),
            })
            .catch(() => {});
        }
        return;
      }
      if (task?.id && context.taskService) {
        context.taskService
          .update(task.id, { status: 'succeeded', progress: `Pulled ${imageRef}`, completedAt: new Date() })
          .catch(() => {});
      }
      await context.registryService?.rememberImageRegistry?.(nodeId, imageRef, registryId);
      context.eventBus?.publish('docker.image.changed', { nodeId, ref: imageRef, action: 'pulled' });
    })
    .catch((err) => {
      if (task?.id && context.taskService) {
        context.taskService
          .update(task.id, {
            status: 'failed',
            error: err instanceof Error ? err.message : 'Pull failed',
            completedAt: new Date(),
          })
          .catch(() => {});
      }
    });

  return { taskId: task?.id, message: `Pulling ${imageRef}...` };
}

export async function removeImage(
  context: DockerImageOperationContext,
  nodeId: string,
  imageId: string,
  force: boolean,
  userId: string
) {
  const result = await context.nodeDispatch.sendDockerImageCommand(nodeId, 'remove', { imageRef: imageId, force });
  context.parseResult(result);
  await context.auditService.log({
    action: 'docker.image.remove',
    userId,
    resourceType: 'docker-image',
    resourceId: imageId,
    details: { nodeId },
  });
  context.eventBus?.publish('docker.image.changed', { nodeId, ref: imageId, action: 'removed' });
}

export async function pruneImages(context: DockerImageOperationContext, nodeId: string, userId: string) {
  const images = await listAllImages(context, nodeId);
  const deleted: string[] = [];
  let spaceReclaimed = 0;
  if (Array.isArray(images)) {
    for (const image of images) {
      if (isGatewayInternalImage(image) || !isDanglingDockerImage(image)) continue;
      const imageId = String(image.id ?? image.Id ?? '');
      if (!imageId) continue;
      try {
        const result = await context.nodeDispatch.sendDockerImageCommand(nodeId, 'remove', {
          imageRef: imageId,
          force: false,
        });
        context.parseResult(result);
        deleted.push(imageId);
        spaceReclaimed += Number(image.size ?? image.Size ?? 0);
      } catch {
        // Docker rejects in-use or parent images; keep pruning the remaining safe candidates.
      }
    }
  }
  const data = { ImagesDeleted: deleted, SpaceReclaimed: spaceReclaimed };
  await context.auditService.log({
    action: 'docker.image.prune',
    userId,
    resourceType: 'docker-image',
    details: { nodeId },
  });
  context.eventBus?.publish('docker.image.changed', { nodeId, ref: '*', action: 'pruned' });
  return data;
}
