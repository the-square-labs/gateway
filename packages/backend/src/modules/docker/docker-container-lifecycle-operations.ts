import { AppError } from '@/middleware/error-handler.js';
import { DOCKER_STOP_TIMEOUT_MAX_SECONDS } from './docker.schemas.js';
import type { DockerContainerMutationContext } from './docker-container-mutation-operations.js';
import type { ContainerTransition } from './docker-container-transitions.js';
import type { DockerTransitionOutcome } from './docker-lifecycle-watch.js';
import { validateDockerRuntimeResourceConfig } from './docker-runtime-operations.js';

/** States with a process for a stop to end. Docker leaves a created, exited or dead container as it is. */
const STOPPABLE_CONTAINER_STATES = new Set(['running', 'restarting', 'paused']);

/** Transitions that end with the container stopped: a stop or a removal waits for them instead of refusing. */
const STOPPING_TRANSITIONS: readonly ContainerTransition[] = ['stopping', 'killing'];

/** An inspect that shows no process left: the stop or kill is done. */
function hasNoProcess(data: Record<string, any>): boolean {
  const status = data?.State?.Status;
  return typeof status === 'string' && !STOPPABLE_CONTAINER_STATES.has(status);
}

/** SIGKILL always ends the process; any other signal may leave it running. */
function signalEndsProcess(signal: string): boolean {
  return /^(?:(?:SIG)?KILL|9)$/i.test(signal.trim());
}

/**
 * Waits for a stop or kill of `name` that runs in this process to end, as a second `docker stop` waits for the
 * first. The wait is bounded by the longest stop a request can ask for; the caller checks the transition again.
 */
export async function waitForStopInFlight(ctx: DockerContainerMutationContext, nodeId: string, name: string) {
  await ctx.waitWhileTransition(
    nodeId,
    name,
    STOPPING_TRANSITIONS,
    ctx.lifecycleWatchTimeoutMs(DOCKER_STOP_TIMEOUT_MAX_SECONDS)
  );
}

/**
 * A lifecycle request answers once its task completed. One that did not complete is an error that names the task;
 * the task records the same outcome.
 */
function requireCompleted(outcome: DockerTransitionOutcome, taskId: string | undefined, done: string) {
  if (outcome.completed) return;
  const details = taskId ? { taskId } : undefined;
  if (outcome.reason === 'disconnected') {
    throw new AppError(502, 'NODE_OFFLINE', `The Docker node disconnected before the container ${done}`, details);
  }
  throw new AppError(504, 'CONTAINER_OPERATION_TIMEOUT', `The container has not ${done} in time`, details);
}

export async function startContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  userId: string
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  ctx.requireNoTransition(nodeId, name);
  if (ctx.runtimeSettingsService) {
    const persistedRuntime = await ctx.runtimeSettingsService.get(nodeId, name);
    if (persistedRuntime) {
      await validateDockerRuntimeResourceConfig(
        ctx.runtimeOperationContext(),
        nodeId,
        containerId,
        persistedRuntime as Record<string, unknown>
      );
      const updateResult = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'live_update', {
        containerId,
        configJson: JSON.stringify(persistedRuntime),
      });
      ctx.parseResult(updateResult);
    }
  }
  const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'start', { containerId });
  ctx.parseResult(result);
  await ctx.auditService.log({
    action: 'docker.container.start',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name },
  });
  ctx.emitContainer(nodeId, name, containerId, 'started');
  return { containerId, name };
}

/** False only when an inspect shows no process to stop; an inspect failure leaves the decision to the stop. */
async function containerHasProcessToStop(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string
): Promise<boolean> {
  try {
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
    const status = ctx.parseResult(result)?.State?.Status;
    return typeof status !== 'string' || STOPPABLE_CONTAINER_STATES.has(status);
  } catch {
    return true;
  }
}

/**
 * Answers once the container has stopped, as `docker stop` does: a read or a removal right after the answer sees
 * it stopped. A stop already running here is waited for; this stop then finds the container stopped.
 */
export async function stopContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  timeout: number | undefined,
  userId: string
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  await waitForStopInFlight(ctx, nodeId, name);
  const stopTimeout = await ctx.resolveContainerStopTimeout(nodeId, containerId, timeout);
  ctx.requireNoTransition(nodeId, name);
  if (!(await containerHasProcessToStop(ctx, nodeId, containerId))) {
    // A container that never started (created) or already exited is stopped: the stop completes now instead of
    // holding "stopping" until a watch for an `exited` state that never comes times out.
    const task = await ctx.createTask(nodeId, containerId, name, 'stop');
    if (task && ctx.taskService) {
      await ctx.taskService
        .update(task.id, { status: 'succeeded', progress: 'Container stopped', completedAt: new Date() })
        .catch(() => undefined);
    }
    await ctx.auditService.log({
      action: 'docker.container.stop',
      userId,
      resourceType: 'docker-container',
      resourceId: containerId,
      details: { nodeId, name, containerName: name },
    });
    ctx.emitContainer(nodeId, name, containerId, 'stopped');
    return { taskId: task?.id, containerId, name };
  }
  ctx.setTransition(nodeId, name, 'stopping');
  ctx.emitTransition(nodeId, name, containerId, 'stopping');
  const task = await ctx.createTask(nodeId, containerId, name, 'stop');
  try {
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'stop', {
      containerId,
      timeoutSeconds: stopTimeout,
      configJson: JSON.stringify({ timeoutProvided: true }),
    });
    ctx.parseResult(result);
  } catch (err) {
    await ctx.failTask(task?.id, err instanceof Error ? err.message : 'Failed to stop container', nodeId, name);
    throw err;
  }
  // The daemon stops the container in the background: the watch sees it end.
  const stopped = ctx.watchTransition(
    nodeId,
    containerId,
    name,
    task?.id,
    'exited',
    'Container stopped',
    'stopped',
    ctx.lifecycleWatchTimeoutMs(stopTimeout),
    hasNoProcess
  );
  await ctx.auditService.log({
    action: 'docker.container.stop',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name },
  });
  requireCompleted(await stopped, task?.id, 'stopped');
  return { taskId: task?.id, containerId, name };
}

/** Answers once Docker has started the container again. */
export async function restartContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  timeout: number | undefined,
  userId: string
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  const stopTimeout = await ctx.resolveContainerStopTimeout(nodeId, containerId, timeout);
  let previousStartedAt: string | undefined;
  try {
    const inspectResult = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
    previousStartedAt = ctx.parseResult(inspectResult)?.State?.StartedAt;
  } catch {
    previousStartedAt = undefined;
  }
  ctx.requireNoTransition(nodeId, name);
  ctx.setTransition(nodeId, name, 'restarting');
  ctx.emitTransition(nodeId, name, containerId, 'restarting');
  const task = await ctx.createTask(nodeId, containerId, name, 'restart');
  try {
    if (ctx.runtimeSettingsService) {
      const persistedRuntime = await ctx.runtimeSettingsService.get(nodeId, name);
      if (persistedRuntime) {
        await validateDockerRuntimeResourceConfig(
          ctx.runtimeOperationContext(),
          nodeId,
          containerId,
          persistedRuntime as Record<string, unknown>
        );
        const updateResult = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'live_update', {
          containerId,
          configJson: JSON.stringify(persistedRuntime),
        });
        ctx.parseResult(updateResult);
      }
    }
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'restart', {
      containerId,
      timeoutSeconds: stopTimeout,
      configJson: JSON.stringify({ timeoutProvided: true }),
    });
    ctx.parseResult(result);
  } catch (err) {
    await ctx.failTask(task?.id, err instanceof Error ? err.message : 'Failed to restart container', nodeId, name);
    throw err;
  }
  const restarted = ctx.watchTransition(
    nodeId,
    containerId,
    name,
    task?.id,
    'running',
    'Container restarted',
    'restarted',
    ctx.lifecycleWatchTimeoutMs(stopTimeout, 60),
    (data) => {
      const state = data?.State;
      // Docker sets StartedAt when it starts the container again: the restart is done then, as a start is, even
      // when the process exits at once.
      if (!previousStartedAt) return state?.Status === 'running';
      return typeof state?.StartedAt === 'string' && state.StartedAt !== previousStartedAt;
    }
  );
  await ctx.auditService.log({
    action: 'docker.container.restart',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name },
  });
  requireCompleted(await restarted, task?.id, 'restarted');
  return { taskId: task?.id, containerId, name };
}

/**
 * SIGKILL answers once the container has exited. Any other signal may leave the process running: the kill is done
 * once the daemon delivered it.
 */
export async function killContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  signal: string,
  userId: string,
  trustedStableName?: string
) {
  await ctx.validateDockerNode(nodeId);
  // A trusted stable name is supplied only for an already-authorized lifecycle
  // transition whose runtime may be temporarily absent. Direct kill requests
  // must still prove that the target is not a Gateway-owned container.
  if (!trustedStableName) await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = trustedStableName ?? (await ctx.resolveContainerName(nodeId, containerId));
  ctx.setTransition(nodeId, name, 'killing');
  ctx.emitTransition(nodeId, name, containerId, 'killing');
  const task = await ctx.createTask(nodeId, containerId, name, 'kill');
  try {
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'kill', {
      containerId,
      signal,
      configJson: JSON.stringify({ containerName: name, emergency: true }),
    });
    ctx.parseResult(result);
  } catch (err) {
    await ctx.failTask(task?.id, err instanceof Error ? err.message : 'Failed to kill container', nodeId, name);
    throw err;
  }
  const exited = signalEndsProcess(signal)
    ? ctx.watchTransition(
        nodeId,
        containerId,
        name,
        task?.id,
        'exited',
        `Container killed (${signal})`,
        'killed',
        undefined,
        hasNoProcess
      )
    : undefined;
  if (!exited) {
    ctx.clearTransition(nodeId, name);
    ctx.emitTransition(nodeId, name, containerId, null);
    if (task && ctx.taskService) {
      await ctx.taskService
        .update(task.id, { status: 'succeeded', progress: `Sent ${signal}`, completedAt: new Date() })
        .catch(() => undefined);
    }
  }
  await ctx.auditService.log({
    action: 'docker.container.kill',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name, signal },
  });
  if (exited) requireCompleted(await exited, task?.id, 'exited');
  return { taskId: task?.id, containerId, name };
}
