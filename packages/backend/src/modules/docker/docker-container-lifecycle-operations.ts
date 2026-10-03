import type { DockerContainerMutationContext } from './docker-container-mutation-operations.js';
import { validateDockerRuntimeResourceConfig } from './docker-runtime-operations.js';

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
}

/** States with a process for a stop to end. Docker leaves a created, exited or dead container as it is. */
const STOPPABLE_CONTAINER_STATES = new Set(['running', 'restarting', 'paused']);

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
  ctx.watchTransition(
    nodeId,
    containerId,
    name,
    task?.id,
    'exited',
    'Container stopped',
    'stopped',
    ctx.lifecycleWatchTimeoutMs(stopTimeout)
  );
  await ctx.auditService.log({
    action: 'docker.container.stop',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name },
  });
  return { taskId: task?.id, containerId, name };
}

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
  ctx.watchTransition(
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
      return state?.Status === 'running' && (!previousStartedAt || state.StartedAt !== previousStartedAt);
    }
  );
  await ctx.auditService.log({
    action: 'docker.container.restart',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name },
  });
  return { taskId: task?.id, containerId, name };
}

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
  ctx.watchTransition(nodeId, containerId, name, task?.id, 'exited', `Container killed (${signal})`, 'killed');
  await ctx.auditService.log({
    action: 'docker.container.kill',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name, signal },
  });
  return { taskId: task?.id, containerId, name };
}
