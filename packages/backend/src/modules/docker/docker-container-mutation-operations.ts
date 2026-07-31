import type { DrizzleClient } from '@/db/client.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { DockerAccessResourceService } from './docker-access-resource.service.js';
import { normalizeEnvRecord } from './docker-env-operations.js';
import type { ContainerAction } from './docker-lifecycle-watch.js';
import { assertContainerNotUsedByProxy } from './docker-proxy-link.guard.js';
import type { DockerRegistryAuthCandidate, DockerRegistryService } from './docker-registry.service.js';
import {
  applyPersistedDockerRuntimeSettingsToConfig,
  type DockerRuntimeOperationContext,
  persistDockerRuntimeSettings,
  validateDockerRuntimeResourceConfig,
} from './docker-runtime-operations.js';
import type { DockerRuntimeSettingsService } from './docker-runtime-settings.service.js';
import type { DockerSecretService } from './docker-secret.service.js';
import { assertDockerMountChangeAllowed, normalizeMountDefinitionsFromInspect } from './docker-socket-mount.guard.js';
import type { DockerTaskService } from './docker-task.service.js';

export interface DockerContainerMutationContext {
  db: DrizzleClient;
  auditService: AuditService;
  nodeDispatch: NodeDispatchService;
  environmentService?: {
    replace(nodeId: string, containerName: string, env: Record<string, string>): Promise<unknown>;
    rename(nodeId: string, oldName: string, newName: string): Promise<unknown>;
    copy(nodeId: string, sourceName: string, targetName: string): Promise<unknown>;
    getDecryptedMap(nodeId: string, containerName: string): Promise<Record<string, string>>;
  };
  runtimeSettingsService?: DockerRuntimeSettingsService;
  secretService?: DockerSecretService;
  registryService?: DockerRegistryService;
  imageCleanupService?: {
    scheduleCleanupForContainer(nodeId: string, containerName: string, imageRef: string | undefined): Promise<unknown>;
  };
  folderService?: {
    deleteContainerAssignment(nodeId: string, containerName: string): Promise<unknown>;
    renameContainerAssignment(nodeId: string, oldName: string, newName: string): Promise<unknown>;
  };
  accessResourceService?: DockerAccessResourceService;
  taskService?: DockerTaskService;
  longDockerOperationTimeoutMs: number;
  validateDockerNode(nodeId: string): Promise<unknown>;
  assertNameAvailable(nodeId: string, name: string): Promise<void>;
  assertNotManagedDeploymentInternal(nodeId: string, containerId: string): Promise<void>;
  translateNameConflict(err: unknown, name: string): never;
  resolveContainerName(nodeId: string, containerId: string): Promise<string>;
  resolveExpectedRecreateState(nodeId: string, containerId: string): Promise<'running' | 'created'>;
  resolveContainerStopTimeout(nodeId: string, containerId: string, timeout: number | undefined): Promise<number>;
  resolveStopTimeoutFromInspect(inspect: Record<string, any>, config?: Record<string, unknown>): number;
  lifecycleWatchTimeoutMs(stopTimeoutSeconds: number, bufferSeconds?: number): number;
  inspectContainer(nodeId: string, containerId: string): Promise<any>;
  runtimeOperationContext(): DockerRuntimeOperationContext;
  requireNoTransition(nodeId: string, name: string): void;
  setTransition(
    nodeId: string,
    name: string,
    state: 'creating' | 'stopping' | 'restarting' | 'killing' | 'updating' | 'recreating'
  ): void;
  clearTransition(nodeId: string, name: string): void;
  emitContainer(
    nodeId: string,
    name: string,
    id: string,
    action: ContainerAction,
    extra?: Record<string, unknown>
  ): void;
  emitTransition(
    nodeId: string,
    name: string,
    id: string,
    transition: 'stopping' | 'restarting' | 'killing' | 'updating' | 'recreating'
  ): void;
  createTask(
    nodeId: string,
    containerId: string,
    containerName: string,
    type: string
  ): Promise<DockerTaskService extends never ? never : Awaited<ReturnType<DockerTaskService['create']>> | undefined>;
  failTask(taskId: string | undefined, error: string, nodeId?: string, containerName?: string): Promise<void>;
  watchTransition(
    nodeId: string,
    containerId: string,
    name: string,
    taskId: string | undefined,
    expectedState: string,
    progress: string,
    completedAction: ContainerAction,
    timeoutMs?: number,
    isComplete?: (inspectData: Record<string, any>) => boolean
  ): void;
  watchRecreateByName(
    nodeId: string,
    containerName: string,
    oldContainerId: string,
    taskId: string | undefined,
    progress: string,
    expectedState: string,
    timeoutMs?: number
  ): void;
  parseResult(result: { success: boolean; error?: string; detail?: string }): any;
}

export async function createContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  config: Record<string, unknown>,
  userId: string,
  actorScopes: string[] = []
) {
  await assertNodeAllowsServiceCreation(ctx.db, nodeId, 'docker');
  await ctx.validateDockerNode(nodeId);
  assertDockerMountChangeAllowed({ nodeId, actorScopes, nextConfig: config, currentDefinitions: [] });
  const registryId = typeof config.registryId === 'string' ? config.registryId : null;
  delete config.registryId;
  const requestedName = (config.name as string | undefined)?.trim();
  if (requestedName) {
    await ctx.assertNameAvailable(nodeId, requestedName);
    ctx.setTransition(nodeId, requestedName, 'creating');
  }
  let data: any;
  try {
    if (registryId) {
      await pullConfigImage(ctx, nodeId, config, registryId, actorScopes);
    }
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'create', {
      configJson: JSON.stringify(config),
    });
    data = ctx.parseResult(result);
  } catch (err) {
    if (requestedName) ctx.clearTransition(nodeId, requestedName);
    ctx.translateNameConflict(err, requestedName || '');
  } finally {
    if (requestedName) ctx.clearTransition(nodeId, requestedName);
  }
  await ctx.auditService.log({
    action: 'docker.container.create',
    userId,
    resourceType: 'docker-container',
    details: { nodeId, name: config.name, image: config.image },
  });
  const createdName = (requestedName || data?.name || data?.Name || '') as string;
  const newId = (data?.Id ?? data?.id ?? '') as string;
  if (createdName && newId) {
    await ctx.accessResourceService?.ensureContainer(nodeId, createdName, newId, false);
  }
  if (createdName && ctx.environmentService) {
    const env = normalizeEnvRecord(config.env);
    if (env) {
      await ctx.environmentService.replace(nodeId, createdName, env);
    }
  }
  if (typeof config.image === 'string') {
    await ctx.registryService?.rememberImageRegistry?.(nodeId, config.image, registryId);
  }
  if (requestedName && newId) {
    ctx.emitContainer(nodeId, requestedName, newId, 'created');
  }
  return data;
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
}

export async function killContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  signal: string,
  userId: string
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  ctx.requireNoTransition(nodeId, name);
  ctx.setTransition(nodeId, name, 'killing');
  ctx.emitTransition(nodeId, name, containerId, 'killing');
  const task = await ctx.createTask(nodeId, containerId, name, 'kill');
  try {
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'kill', { containerId, signal });
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
}

export async function removeContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  force: boolean,
  userId: string
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  await assertContainerNotUsedByProxy(ctx.db, nodeId, name);
  ctx.requireNoTransition(nodeId, name);
  const inspect = await ctx.inspectContainer(nodeId, containerId);
  const state = String(inspect?.State?.Status ?? inspect?.state ?? inspect?.State ?? '').toLowerCase();
  const isActive =
    inspect?.State?.Running === true ||
    inspect?.State?.Paused === true ||
    inspect?.State?.Restarting === true ||
    ['running', 'paused', 'restarting'].includes(state);
  if (isActive) {
    throw new AppError(
      409,
      'CONTAINER_RUNNING',
      'Stop the container before removing it. Active containers cannot be removed from Gateway.'
    );
  }
  const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'remove', { containerId, force });
  ctx.parseResult(result);
  await ctx.auditService.log({
    action: 'docker.container.remove',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name, force },
  });
  if (ctx.folderService) {
    await ctx.folderService.deleteContainerAssignment(nodeId, name);
  }
  const removedScopeResourceId = await ctx.accessResourceService?.removeContainer(nodeId, name);
  if (ctx.runtimeSettingsService) {
    await ctx.runtimeSettingsService.delete(nodeId, name);
  }
  ctx.emitContainer(nodeId, name, containerId, 'removed', {
    ...(removedScopeResourceId ? { scopeResourceId: removedScopeResourceId } : {}),
  });
}

export async function renameContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  newName: string,
  userId: string
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const oldName = await ctx.resolveContainerName(nodeId, containerId);
  ctx.requireNoTransition(nodeId, oldName);
  await ctx.assertNameAvailable(nodeId, newName);
  ctx.setTransition(nodeId, newName, 'creating');
  try {
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'rename', { containerId, newName });
    ctx.parseResult(result);
  } catch (err) {
    ctx.translateNameConflict(err, newName);
  } finally {
    ctx.clearTransition(nodeId, newName);
  }
  if (ctx.environmentService) {
    await ctx.environmentService.rename(nodeId, oldName, newName);
  }
  if (ctx.runtimeSettingsService) {
    await ctx.runtimeSettingsService.rename(nodeId, oldName, newName);
  }
  if (ctx.folderService) {
    await ctx.folderService.renameContainerAssignment(nodeId, oldName, newName);
  }
  await ctx.accessResourceService?.renameContainer(nodeId, oldName, newName);
  await ctx.auditService.log({
    action: 'docker.container.rename',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, oldName, name: newName, containerName: newName },
  });
  ctx.emitContainer(nodeId, newName, containerId, 'renamed', { oldName });
}

export async function duplicateContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  name: string,
  userId: string,
  actorScopes: string[] = []
) {
  await assertNodeAllowsServiceCreation(ctx.db, nodeId, 'docker');
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const sourceName = await ctx.resolveContainerName(nodeId, containerId);
  const inspect = await ctx.inspectContainer(nodeId, containerId);
  assertDockerMountChangeAllowed({
    nodeId,
    resourceId: String(inspect?.scopeResourceId ?? ''),
    actorScopes,
    currentDefinitions: [],
    nextDefinitions: normalizeMountDefinitionsFromInspect(inspect),
  });
  ctx.requireNoTransition(nodeId, sourceName);
  await ctx.assertNameAvailable(nodeId, name);
  ctx.setTransition(nodeId, name, 'creating');
  let data: any;
  try {
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'duplicate', {
      containerId,
      newName: name,
    });
    data = ctx.parseResult(result);
  } catch (err) {
    ctx.translateNameConflict(err, name);
  } finally {
    ctx.clearTransition(nodeId, name);
  }

  // Copy secrets from source container to the new one (keyed by name)
  if (ctx.environmentService) {
    await ctx.environmentService.copy(nodeId, sourceName, name);
  }
  if (ctx.runtimeSettingsService) {
    await ctx.runtimeSettingsService.copy(nodeId, sourceName, name);
  }
  if (ctx.secretService) {
    await ctx.secretService.copySecrets(nodeId, sourceName, name, userId);
  }

  await ctx.auditService.log({
    action: 'docker.container.duplicate',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, sourceName, name, containerName: name },
  });
  const newId = (data?.Id ?? data?.id ?? '') as string;
  if (newId) await ctx.accessResourceService?.ensureContainer(nodeId, name, newId, false);
  if (newId) ctx.emitContainer(nodeId, name, newId, 'duplicated', { sourceName });
  return data;
}

export async function updateContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  config: Record<string, unknown>,
  userId: string,
  actorScopes: string[] = []
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  const inspect = await ctx.inspectContainer(nodeId, containerId);
  assertDockerMountChangeAllowed({
    nodeId,
    resourceId: String(inspect?.scopeResourceId ?? ''),
    actorScopes,
    nextConfig: config,
    currentInspect: inspect,
    useCurrentWhenNextMissing: true,
  });
  const expectedState = await ctx.resolveExpectedRecreateState(nodeId, containerId);
  if (ctx.environmentService) {
    const storedEnv = await ctx.environmentService.getDecryptedMap(nodeId, name);
    if (Object.keys(storedEnv).length > 0) {
      config.env = { ...storedEnv, ...(normalizeEnvRecord(config.env) || {}) };
    }
  }
  if (ctx.secretService) {
    const secrets = await ctx.secretService.getDecryptedMap(nodeId, name);
    if (Object.keys(secrets).length > 0) {
      config.env = { ...(normalizeEnvRecord(config.env) || {}), ...secrets };
    }
  }
  config = await applyPersistedDockerRuntimeSettingsToConfig(ctx.runtimeOperationContext(), nodeId, name, config);
  const hasImageChange = typeof config.tag === 'string' && config.tag.length > 0;
  const updateStopTimeout = ctx.resolveStopTimeoutFromInspect(inspect as Record<string, any>, config);
  const updateTimeoutMs = hasImageChange
    ? ctx.longDockerOperationTimeoutMs
    : Math.max(120000, ctx.lifecycleWatchTimeoutMs(updateStopTimeout, 60));
  ctx.requireNoTransition(nodeId, name);
  ctx.setTransition(nodeId, name, 'updating');
  ctx.emitTransition(nodeId, name, containerId, 'updating');
  const task = await ctx.createTask(nodeId, containerId, name, 'update');
  let data: any;
  try {
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(
      nodeId,
      'update',
      { containerId, configJson: JSON.stringify(config) },
      updateTimeoutMs
    );
    data = ctx.parseResult(result);
    const newRuntimeId = String(data?.Id ?? data?.id ?? '');
    if (newRuntimeId) {
      await ctx.accessResourceService?.preserveContainerRuntimeId(nodeId, name, newRuntimeId);
    }
  } catch (err) {
    await ctx.failTask(task?.id, err instanceof Error ? err.message : 'Failed to update container', nodeId, name);
    throw err;
  }
  ctx.watchRecreateByName(nodeId, name, containerId, task?.id, 'Container updated', expectedState, updateTimeoutMs);
  await ctx.auditService.log({
    action: 'docker.container.update',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name },
  });
  if (hasImageChange) {
    const imageRef = imageRefWithTag(inspect?.Config?.Image ?? inspect?.Image, config.tag as string);
    ctx.imageCleanupService?.scheduleCleanupForContainer(nodeId, name, imageRef).catch(() => {});
  }
  return data;
}

export async function liveUpdateContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  config: Record<string, unknown>,
  userId: string
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  ctx.requireNoTransition(nodeId, name);
  await validateDockerRuntimeResourceConfig(ctx.runtimeOperationContext(), nodeId, containerId, config);
  const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'live_update', {
    containerId,
    configJson: JSON.stringify(config),
  });
  ctx.parseResult(result);
  await persistDockerRuntimeSettings(ctx.runtimeOperationContext(), nodeId, name, config);
  await ctx.auditService.log({
    action: 'docker.container.live_update',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name },
  });
}

export async function recreateWithConfig(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  config: Record<string, unknown>,
  userId: string,
  options?: { skipImagePull?: boolean; skipWebhookCleanup?: boolean; actorScopes?: string[] }
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  const expectedState = await ctx.resolveExpectedRecreateState(nodeId, containerId);
  ctx.requireNoTransition(nodeId, name);
  config = await applyPersistedDockerRuntimeSettingsToConfig(ctx.runtimeOperationContext(), nodeId, name, config);
  const normalizedEnv = normalizeEnvRecord(config.env);
  if (normalizedEnv) {
    config.env = normalizedEnv;
  } else {
    delete config.env;
  }
  const inspect = await ctx.inspectContainer(nodeId, containerId);
  const recreateStopTimeout = ctx.resolveStopTimeoutFromInspect(inspect as Record<string, any>, config);
  assertDockerMountChangeAllowed({
    nodeId,
    resourceId: String(inspect?.scopeResourceId ?? ''),
    actorScopes: options?.actorScopes ?? [],
    nextConfig: config,
    currentInspect: inspect,
    useCurrentWhenNextMissing: true,
  });
  await validateDockerRuntimeResourceConfig(ctx.runtimeOperationContext(), nodeId, containerId, config);
  ctx.setTransition(nodeId, name, 'recreating');
  ctx.emitTransition(nodeId, name, containerId, 'recreating');
  const task = await ctx.createTask(nodeId, containerId, name, 'recreate');

  // Inject decrypted secrets into the recreate config's env (keyed by container name)
  if (ctx.environmentService) {
    const storedEnv = await ctx.environmentService.getDecryptedMap(nodeId, name);
    if (Object.keys(storedEnv).length > 0) {
      const existingEnv = normalizeEnvRecord(config.env) || {};
      config.env = { ...storedEnv, ...existingEnv };
    }
  }

  if (ctx.secretService) {
    const secrets = await ctx.secretService.getDecryptedMap(nodeId, name);
    if (Object.keys(secrets).length > 0) {
      const existingEnv = normalizeEnvRecord(config.env) || {};
      config.env = { ...existingEnv, ...secrets };
    }
  }

  try {
    if (!options?.skipImagePull) {
      await pullConfigImage(ctx, nodeId, config, undefined, options?.actorScopes ?? []);
    }

    const result = await ctx.nodeDispatch.sendDockerContainerCommand(
      nodeId,
      'recreate',
      { containerId, configJson: JSON.stringify(config) },
      Math.max(120000, ctx.lifecycleWatchTimeoutMs(recreateStopTimeout, 60))
    );
    const data = ctx.parseResult(result);
    const newRuntimeId = String(data?.Id ?? data?.id ?? '');
    if (newRuntimeId) {
      await ctx.accessResourceService?.preserveContainerRuntimeId(nodeId, name, newRuntimeId);
    }
    await ctx.auditService.log({
      action: 'docker.container.recreate',
      userId,
      resourceType: 'docker-container',
      resourceId: containerId,
      details: { nodeId, name, containerName: name },
    });
    if (!options?.skipWebhookCleanup && typeof config.image === 'string') {
      ctx.imageCleanupService?.scheduleCleanupForContainer(nodeId, name, config.image).catch(() => {});
    }

    ctx.watchRecreateByName(
      nodeId,
      name,
      containerId,
      task?.id,
      'Container recreated',
      expectedState,
      ctx.lifecycleWatchTimeoutMs(recreateStopTimeout, 60)
    );
    return data;
  } catch (err) {
    ctx.clearTransition(nodeId, name);
    if (task && ctx.taskService) {
      await ctx.taskService
        .update(task.id, {
          status: 'failed',
          error: err instanceof Error ? err.message : 'Unknown error',
          completedAt: new Date(),
        })
        .catch(() => {});
    }
    throw err;
  }
}

async function pullConfigImage(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  config: Record<string, unknown>,
  registryId?: string,
  actorScopes: string[] = []
) {
  const imageRef = typeof config.image === 'string' ? config.image.trim() : '';
  if (!imageRef) return;

  const authCandidates =
    (await ctx.registryService?.resolveAuthCandidatesForImagePull(nodeId, imageRef, registryId, {
      actorScopes,
    })) ?? [];
  const pullCandidates: Array<DockerRegistryAuthCandidate | null> = authCandidates.length ? authCandidates : [null];
  let lastError: unknown;

  for (const auth of pullCandidates) {
    let finalImageRef = imageRef;
    if (auth && !hasRegistryHost(imageRef)) {
      finalImageRef = `${auth.url}/${imageRef}`;
    }

    try {
      const result = await ctx.nodeDispatch.sendDockerImageCommand(
        nodeId,
        'pull',
        { imageRef: finalImageRef, registryAuthJson: auth?.authJson },
        ctx.longDockerOperationTimeoutMs
      );
      ctx.parseResult(result);
      config.image = finalImageRef;
      await ctx.registryService?.rememberImageRegistry?.(nodeId, finalImageRef, auth?.registryId);
      return;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new AppError(502, 'DISPATCH_ERROR', `Failed to pull ${imageRef}`);
}

function hasRegistryHost(imageRef: string) {
  const firstSegment = imageRef.split('/')[0] ?? '';
  return firstSegment === 'localhost' || firstSegment.includes('.') || firstSegment.includes(':');
}

function imageRefWithTag(imageRef: string | undefined, tag: string) {
  const trimmedTag = tag.trim();
  if (!imageRef || !trimmedTag) return undefined;
  const digestIndex = imageRef.indexOf('@');
  const withoutDigest = digestIndex >= 0 ? imageRef.slice(0, digestIndex) : imageRef;
  const lastColon = withoutDigest.lastIndexOf(':');
  const lastSlash = withoutDigest.lastIndexOf('/');
  const imageName = lastColon >= 0 && lastSlash < lastColon ? withoutDigest.slice(0, lastColon) : withoutDigest;
  return `${imageName}:${trimmedTag}`;
}

export async function updateContainerEnv(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  env: Record<string, string> | undefined,
  removeEnv: string[] | undefined,
  userId: string
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  const name = await ctx.resolveContainerName(nodeId, containerId);
  const expectedState = await ctx.resolveExpectedRecreateState(nodeId, containerId);
  const updateStopTimeout = await ctx.resolveContainerStopTimeout(nodeId, containerId, undefined);
  ctx.requireNoTransition(nodeId, name);

  // Merge decrypted secrets into the env update so secrets persist across recreate
  let mergedEnv = env;
  if (ctx.secretService) {
    const secrets = await ctx.secretService.getDecryptedMap(nodeId, name);
    if (Object.keys(secrets).length > 0) {
      mergedEnv = { ...(env || {}), ...secrets };
      // Never allow removing a secret key via removeEnv
      if (removeEnv) {
        const secretKeys = new Set(Object.keys(secrets));
        removeEnv = removeEnv.filter((k) => !secretKeys.has(k));
      }
    }
  }

  ctx.setTransition(nodeId, name, 'updating');
  ctx.emitTransition(nodeId, name, containerId, 'updating');
  const task = await ctx.createTask(nodeId, containerId, name, 'update');
  let data: any;
  try {
    const result = await ctx.nodeDispatch.sendDockerContainerCommand(
      nodeId,
      'update',
      { containerId, configJson: JSON.stringify({ env: mergedEnv, removeEnv }) },
      Math.max(60000, ctx.lifecycleWatchTimeoutMs(updateStopTimeout, 60))
    );
    data = ctx.parseResult(result);
    if (ctx.environmentService) {
      await ctx.environmentService.replace(nodeId, name, env || {});
    }
  } catch (err) {
    ctx.clearTransition(nodeId, name);
    if (task && ctx.taskService) {
      await ctx.taskService
        .update(task.id, {
          status: 'failed',
          error: err instanceof Error ? err.message : 'Unknown error',
          completedAt: new Date(),
        })
        .catch(() => {});
    }
    throw err;
  }
  ctx.watchRecreateByName(
    nodeId,
    name,
    containerId,
    task?.id,
    'Container env updated',
    expectedState,
    ctx.lifecycleWatchTimeoutMs(updateStopTimeout, 60)
  );
  await ctx.auditService.log({
    action: 'docker.container.env.update',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name },
  });

  return data;
}
