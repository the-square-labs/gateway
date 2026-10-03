import { AppError } from '@/middleware/error-handler.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { getReplacementContainerFailureMessage } from './docker-recreate-watch.js';
import type { DockerTaskService } from './docker-task.service.js';

const LEGACY_TASK_STATUS_UNSUPPORTED_ERROR = 'unknown container action: task_status';
const NODE_DISCONNECTED_RE = /node .* (?:is not connected|disconnected)/i;

function isNodeDisconnectedError(error: unknown): boolean {
  return NODE_DISCONNECTED_RE.test(error instanceof Error ? error.message : String(error));
}

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

/** How a watched lifecycle operation ended; its task records the same outcome. */
export type DockerTransitionOutcome = { completed: true } | { completed: false; reason: 'timeout' | 'disconnected' };

/**
 * Polls the container until the operation reached its state, then completes its task and ends its transition.
 * The returned promise settles once the task did; it never rejects. A container that no longer exists has no
 * process left: an operation that waits for `exited` (stop, kill) is then complete.
 */
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
): Promise<DockerTransitionOutcome> {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const complete = async () => {
      settled = true;
      clearInterval(poll);
      context.clearTransition(nodeId, name);
      if (taskId && context.taskService) {
        await context.taskService
          .update(taskId, { status: 'succeeded', progress, completedAt: new Date() })
          .catch(() => {});
      }
      context.emitContainer(nodeId, name, containerId, completedAction);
      resolve({ completed: true });
    };
    const fail = async (reason: 'timeout' | 'disconnected') => {
      settled = true;
      clearInterval(poll);
      await context.failTask(
        taskId,
        reason === 'timeout' ? 'Timed out' : 'Docker node disconnected during container operation',
        nodeId,
        name
      );
      resolve({ completed: false, reason });
    };
    const poll = setInterval(async () => {
      try {
        const result = await context.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
        if (settled) return;
        const data = context.parseResult(result) as Record<string, any>;
        const state = data?.State?.Status;
        const completed = isComplete ? isComplete(data) : state === expectedState;
        if (completed) {
          await complete();
          return;
        }
        if (Date.now() - start > timeoutMs) await fail('timeout');
      } catch (error) {
        if (settled) return;
        if (isNodeDisconnectedError(error)) {
          await fail('disconnected');
          return;
        }
        if (expectedState === 'exited' && error instanceof AppError && error.code === 'CONTAINER_NOT_FOUND') {
          await complete();
          return;
        }
        if (Date.now() - start > timeoutMs) await fail('timeout');
      }
    }, 2000);
  });
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
  onComplete?: (newContainerId: string) => Promise<void>,
  daemonTaskId?: string,
  // Runs when the async daemon task reports that the change was not applied,
  // before the task is failed and the container transition is released.
  onDaemonTaskFailed?: () => Promise<void>
) {
  const start = Date.now();
  const poll = setInterval(async () => {
    try {
      const result = await context.nodeDispatch.sendDockerContainerCommand(nodeId, 'list');
      const containers = context.parseResult(result);
      if (!Array.isArray(containers)) throw new Error('Docker container list returned an invalid response');

      let daemonTaskStatus: string | undefined;
      if (daemonTaskId) {
        const daemonTaskResult = await context.nodeDispatch.sendDockerContainerCommand(nodeId, 'task_status', {
          containerId: daemonTaskId,
        });
        if (!daemonTaskResult.success && daemonTaskResult.error?.trim() === LEGACY_TASK_STATUS_UNSUPPORTED_ERROR) {
          daemonTaskStatus = 'unsupported';
        } else {
          const daemonTask = context.parseResult(daemonTaskResult) as Record<string, any>;
          daemonTaskStatus = String(daemonTask.status ?? '');
          if (daemonTaskStatus === 'failed') {
            clearInterval(poll);
            await onDaemonTaskFailed?.().catch(() => undefined);
            await context.failTask(
              taskId,
              String(daemonTask.error || 'Docker daemon task failed'),
              nodeId,
              containerName
            );
            return;
          }
        }
      }

      const match = containers.find((c: any) => {
        const cName = (c.name ?? c.Name ?? '').replace(/^\//, '');
        return cName === containerName;
      });

      const canEvaluateReplacement =
        !daemonTaskId ||
        daemonTaskStatus === 'running' ||
        daemonTaskStatus === 'succeeded' ||
        daemonTaskStatus === 'unsupported';
      if (match && canEvaluateReplacement) {
        const newId = match.id ?? match.Id;
        const state = match.state ?? match.State ?? '';

        // A replacement that started and now restarts under its restart policy
        // was recreated as asked; waiting for it to stay up would hold the
        // container until the timeout.
        const reached = state === expectedState || (expectedState === 'running' && state === 'restarting');
        if (newId !== oldContainerId && reached) {
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
    } catch (error) {
      if (isNodeDisconnectedError(error)) {
        clearInterval(poll);
        await context.failTask(taskId, 'Docker node disconnected during container operation', nodeId, containerName);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(poll);
        await context.failTask(taskId, 'Timed out', nodeId, containerName);
      }
    }
  }, 2000);
}
