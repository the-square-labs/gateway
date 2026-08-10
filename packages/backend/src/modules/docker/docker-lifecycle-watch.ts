import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { getReplacementContainerFailureMessage } from './docker-recreate-watch.js';
import type { DockerTaskService } from './docker-task.service.js';

export type ContainerAction =
  | 'created'
  | 'started'
  | 'stopped'
  | 'restarted'
  | 'killed'
  | 'removed'
  | 'renamed'
  | 'updated'
  | 'recreated'
  | 'duplicated';

export interface DockerLifecycleWatchContext {
  nodeDispatch: NodeDispatchService;
  taskService?: DockerTaskService;
  eventBus?: EventBusService;
  parseResult: (result: { success: boolean; error?: string; detail?: string }) => unknown;
  clearTransition: (nodeId: string, name: string) => void;
  emitContainer: (
    nodeId: string,
    name: string,
    id: string,
    action: ContainerAction,
    extra?: Record<string, unknown>
  ) => void;
  preserveContainerIdentity?: (nodeId: string, name: string, runtimeId: string) => Promise<unknown>;
  failTask: (taskId: string | undefined, error: string, nodeId?: string, containerName?: string) => Promise<void>;
}

export function watchDockerTransition(
  context: DockerLifecycleWatchContext,
  nodeId: string,
  containerId: string,
  name: string,
  taskId: string | undefined,
  expectedState: string,
  progress: string,
  completedAction: ContainerAction,
  timeoutMs = 60000,
  isComplete?: (inspectData: Record<string, any>) => boolean
) {
  const start = Date.now();
  const poll = setInterval(async () => {
    try {
      const result = await context.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
      const data = context.parseResult(result) as Record<string, any>;
      const state = data?.State?.Status;
      const completed = isComplete ? isComplete(data) : state === expectedState;
      if (completed) {
        clearInterval(poll);
        context.clearTransition(nodeId, name);
        if (taskId && context.taskService) {
          await context.taskService
            .update(taskId, { status: 'succeeded', progress, completedAt: new Date() })
            .catch(() => {});
        }
        context.emitContainer(nodeId, name, containerId, completedAction);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(poll);
        await context.failTask(taskId, 'Timed out', nodeId, name);
      }
    } catch {
      // Container might not exist during recreate — keep polling
      if (Date.now() - start > timeoutMs) {
        clearInterval(poll);
        await context.failTask(taskId, 'Timed out', nodeId, name);
      }
    }
  }, 2000);
}

export function watchDockerRecreateByName(
  context: DockerLifecycleWatchContext,
  nodeId: string,
  containerName: string,
  oldContainerId: string,
  taskId: string | undefined,
  progress: string,
  expectedState: string,
  timeoutMs = 60000,
  onComplete?: (newContainerId: string) => Promise<void>
) {
  const start = Date.now();
  const poll = setInterval(async () => {
    try {
      const result = await context.nodeDispatch.sendDockerContainerCommand(nodeId, 'list');
      const containers = context.parseResult(result);
      if (!Array.isArray(containers)) return;

      const match = containers.find((c: any) => {
        const cName = (c.name ?? c.Name ?? '').replace(/^\//, '');
        return cName === containerName;
      });

      if (match) {
        const newId = match.id ?? match.Id;
        const state = match.state ?? match.State ?? '';

        if (newId !== oldContainerId && state === expectedState) {
          clearInterval(poll);
          try {
            await context.preserveContainerIdentity?.(nodeId, containerName, newId);
            await onComplete?.(newId);
          } catch (error) {
            context.clearTransition(nodeId, containerName);
            await context.failTask(
              taskId,
              error instanceof Error ? error.message : 'Failed to finalize recreated container',
              nodeId,
              containerName
            );
            return;
          }
          context.clearTransition(nodeId, containerName);
          if (taskId && context.taskService) {
            await context.taskService
              .update(taskId, { status: 'succeeded', progress, completedAt: new Date() })
              .catch(() => {});
          }
          context.emitContainer(nodeId, containerName, newId, 'recreated', { oldId: oldContainerId });
          return;
        }

        const replacementFailure = getReplacementContainerFailureMessage(match, oldContainerId, expectedState);
        if (replacementFailure) {
          clearInterval(poll);
          await context.failTask(taskId, replacementFailure, nodeId, containerName);
          return;
        }
      }

      if (Date.now() - start > timeoutMs) {
        clearInterval(poll);
        await context.failTask(taskId, 'Timed out', nodeId, containerName);
      }
    } catch {
      if (Date.now() - start > timeoutMs) {
        clearInterval(poll);
        await context.failTask(taskId, 'Timed out', nodeId, containerName);
      }
    }
  }, 2000);
}
