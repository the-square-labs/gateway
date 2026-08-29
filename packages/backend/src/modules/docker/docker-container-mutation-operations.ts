import type { DrizzleClient } from '@/db/client.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { DockerAccessResourceService } from './docker-access-resource.service.js';
import { envListToMap, envMapToList, normalizeEnvRecord } from './docker-env-operations.js';
import { dockerGpuAttachmentFromInspect, hasRequestedGpuChange } from './docker-gpu-attachment.js';
import type { ContainerAction } from './docker-lifecycle-watch.js';
import { assertManagedMountMutation } from './docker-managed-mounts.js';
import { hasRequestedSpecificPortBindIp } from './docker-port-bindings.js';
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
import {
  assertDockerMountChangeAllowed,
  normalizeMountDefinitionsFromConfig,
  normalizeMountDefinitionsFromInspect,
} from './docker-socket-mount.guard.js';
import type { DockerTaskService } from './docker-task.service.js';

const logger = createChildLogger('DockerContainerMutationOperations');

export interface DockerContainerMutationContext {
  db: DrizzleClient;
  auditService: AuditService;
  nodeDispatch: NodeDispatchService;
  environmentService?: {
    replace(nodeId: string, containerName: string, env: Record<string, string>): Promise<unknown>;
    deleteImported(nodeId: string, containerName: string): Promise<unknown>;
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
  assertDockerGpuCapability(nodeId: string): Promise<void>;
  assertDockerPortBindIpCapability(nodeId: string): Promise<void>;
  assertDockerRuntimeProfileAvailable(nodeId: string, profile: unknown, currentProfile?: unknown): Promise<void>;
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
    timeoutMs?: number,
    onComplete?: (newContainerId: string) => Promise<void>,
    daemonTaskId?: string
  ): void;
  parseResult(result: { success: boolean; error?: string; detail?: string }): any;
}

export function daemonContainerCreateConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { volumes, networks, command, ...daemonConfig } = config;
  const normalizedEnv = normalizeEnvRecord(config.env);
  const binds = Array.isArray(volumes)
    ? volumes.map((value) => {
        const mount = value as Record<string, unknown>;
        const source = typeof mount.hostPath === 'string' ? mount.hostPath : mount.name;
        const suffix = mount.readOnly === true ? ':ro' : '';
        return `${String(source)}:${String(mount.containerPath)}${suffix}`;
      })
    : undefined;
  const primaryNetwork = Array.isArray(networks) && typeof networks[0] === 'string' ? networks[0] : undefined;
  const legacyPortBindings = Array.isArray(config.ports)
    ? Object.fromEntries(
        config.ports.flatMap((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const port = value as Record<string, unknown>;
          if (typeof port.containerPort !== 'number' || typeof port.hostPort !== 'number') return [];
          const protocol = port.protocol === 'udp' ? 'udp' : 'tcp';
          return [[`${port.containerPort}/${protocol}`, String(port.hostPort)]];
        })
      )
    : null;
  return {
    ...daemonConfig,
    ...(normalizedEnv ? { env: envMapToList(normalizedEnv) } : {}),
    ...(binds ? { binds } : {}),
    ...(Array.isArray(command) ? { cmd: command } : {}),
    ...(primaryNetwork ? { network_mode: primaryNetwork } : {}),
    ...(legacyPortBindings && Object.keys(legacyPortBindings).length > 0 ? { port_bindings: legacyPortBindings } : {}),
  };
}

function asyncDaemonTaskId(data: any, expectedType: string): string | undefined {
  const status = String(data?.status ?? '');
  return data?.type === expectedType && ['pending', 'running', 'succeeded', 'failed'].includes(status)
    ? String(data.id ?? '') || undefined
    : undefined;
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
  if (hasRequestedGpuChange(config)) await ctx.assertDockerGpuCapability(nodeId);
  await ctx.assertDockerRuntimeProfileAvailable(nodeId, config.runtimeProfile);
  assertSecureRuntimeConfiguration(config);
  if (hasRequestedSpecificPortBindIp(config)) await ctx.assertDockerPortBindIpCapability(nodeId);
  assertDockerMountChangeAllowed({ nodeId, actorScopes, nextConfig: config, currentDefinitions: [] });
  await assertManagedMountMutation({
    db: ctx.db,
    dispatch: ctx.nodeDispatch,
    parseResult: ctx.parseResult,
    nodeId,
    current: [],
    next: normalizeMountDefinitionsFromConfig(config),
  });
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
      configJson: JSON.stringify(daemonContainerCreateConfig(config)),
    });
    data = ctx.parseResult(result);
  } catch (err) {
    if (requestedName) ctx.clearTransition(nodeId, requestedName);
    ctx.translateNameConflict(err, requestedName || '');
  } finally {
    if (requestedName) ctx.clearTransition(nodeId, requestedName);
  }
  let createdName = (requestedName || data?.name || data?.Name || '') as string;
  const newId = (data?.Id ?? data?.id ?? '') as string;
  try {
    if (!createdName && newId) {
      const inspect = await ctx.inspectContainer(nodeId, newId);
      createdName = String(inspect?.Name ?? inspect?.name ?? '').replace(/^\//, '');
    }
    await ctx.auditService.log({
      action: 'docker.container.create',
      userId,
      resourceType: 'docker-container',
      resourceId: newId,
      details: { nodeId, name: createdName, image: config.image },
    });
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
  } catch (error) {
    try {
      await rollbackCreatedContainer(
        ctx,
        nodeId,
        newId || createdName || requestedName || '',
        createdName || requestedName
      );
    } catch (rollbackError) {
      const primaryMessage = error instanceof Error ? error.message : String(error);
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(`${primaryMessage} (container rollback failed: ${rollbackMessage})`);
    }
    throw error;
  }
  if (requestedName && newId) {
    ctx.emitContainer(nodeId, requestedName, newId, 'created');
  }
  return data && typeof data === 'object' ? { ...data, id: newId, name: createdName } : data;
}

export async function rollbackCreatedContainer(
  ctx: DockerContainerMutationContext,
  nodeId: string,
  containerId: string,
  knownName?: string,
  userId?: string
) {
  if (!containerId) throw new Error('Created Docker container identity is unavailable for rollback');
  let name = knownName?.replace(/^\//, '') ?? '';
  if (!name) {
    try {
      name = await ctx.resolveContainerName(nodeId, containerId);
    } catch {
      name = '';
    }
  }
  const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'remove', {
    containerId,
    force: true,
  });
  ctx.parseResult(result);
  if (name) {
    await Promise.allSettled([
      ctx.environmentService?.deleteImported(nodeId, name),
      ctx.runtimeSettingsService?.delete(nodeId, name),
      ctx.secretService?.deleteImported(nodeId, name),
      ctx.folderService?.deleteContainerAssignment(nodeId, name),
      ctx.accessResourceService?.removeContainer(nodeId, name),
    ]);
  }
  if (userId) {
    await ctx.auditService
      .log({
        action: 'docker.container.create.rollback',
        userId,
        resourceType: 'docker-container',
        resourceId: containerId,
        details: { nodeId, name },
      })
      .catch(() => undefined);
  }
  if (name) ctx.emitContainer(nodeId, name, containerId, 'removed');
  return { id: containerId, name };
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
  const [, , , , accessResult] = await Promise.all([
    ctx.environmentService?.deleteImported(nodeId, name),
    ctx.runtimeSettingsService?.delete(nodeId, name),
    ctx.secretService?.deleteImported(nodeId, name),
    ctx.folderService?.deleteContainerAssignment(nodeId, name),
    ctx.accessResourceService?.removeContainer(nodeId, name),
  ]);
  const removedScopeResourceId = accessResult;
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
    // The runtime name is available, so any name-keyed records left behind by a
    // previously deleted container are stale and must not block reuse.
    await Promise.all([
      ctx.environmentService?.deleteImported(nodeId, newName),
      ctx.runtimeSettingsService?.delete(nodeId, newName),
      ctx.secretService?.deleteImported(nodeId, newName),
      ctx.folderService?.deleteContainerAssignment(nodeId, newName),
      ctx.accessResourceService?.removeContainer(nodeId, newName),
    ]);

    try {
      const result = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'rename', { containerId, newName });
      ctx.parseResult(result);
    } catch (err) {
      ctx.translateNameConflict(err, newName);
    }

    const metadataRollbacks: Array<() => Promise<unknown>> = [];
    try {
      if (ctx.environmentService) {
        await ctx.environmentService.rename(nodeId, oldName, newName);
        metadataRollbacks.unshift(() => ctx.environmentService!.rename(nodeId, newName, oldName));
      }
      if (ctx.runtimeSettingsService) {
        await ctx.runtimeSettingsService.rename(nodeId, oldName, newName);
        metadataRollbacks.unshift(() => ctx.runtimeSettingsService!.rename(nodeId, newName, oldName));
      }
      if (ctx.secretService) {
        await ctx.secretService.rename(nodeId, oldName, newName);
        metadataRollbacks.unshift(() => ctx.secretService!.rename(nodeId, newName, oldName));
      }
      if (ctx.folderService) {
        await ctx.folderService.renameContainerAssignment(nodeId, oldName, newName);
        metadataRollbacks.unshift(() => ctx.folderService!.renameContainerAssignment(nodeId, newName, oldName));
      }
      if (ctx.accessResourceService) {
        await ctx.accessResourceService.renameContainer(nodeId, oldName, newName);
        metadataRollbacks.unshift(() => ctx.accessResourceService!.renameContainer(nodeId, newName, oldName));
      }
    } catch (metadataError) {
      try {
        const rollbackResult = await ctx.nodeDispatch.sendDockerContainerCommand(nodeId, 'rename', {
          containerId,
          newName: oldName,
        });
        ctx.parseResult(rollbackResult);
        for (const rollback of metadataRollbacks) await rollback();
      } catch (rollbackError) {
        const primaryMessage = metadataError instanceof Error ? metadataError.message : String(metadataError);
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`${primaryMessage} (rename rollback failed: ${rollbackMessage})`);
      }
      throw metadataError;
    }

    await ctx.auditService.log({
      action: 'docker.container.rename',
      userId,
      resourceType: 'docker-container',
      resourceId: containerId,
      details: { nodeId, oldName, name: newName, containerName: newName },
    });
    ctx.emitContainer(nodeId, newName, containerId, 'renamed', { oldName });
  } finally {
    ctx.clearTransition(nodeId, newName);
  }
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
  await assertManagedMountMutation({
    db: ctx.db,
    dispatch: ctx.nodeDispatch,
    parseResult: ctx.parseResult,
    nodeId,
    current: [],
    next: normalizeMountDefinitionsFromInspect(inspect),
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
    ctx.clearTransition(nodeId, name);
    ctx.translateNameConflict(err, name);
  }
  let newId = String(data?.Id ?? data?.id ?? '');
  if (!newId) {
    try {
      const duplicateInspect = await ctx.inspectContainer(nodeId, name);
      newId = String(duplicateInspect?.Id ?? duplicateInspect?.id ?? '');
    } catch {
      newId = '';
    }
  }
  if (!newId) {
    await ctx.nodeDispatch
      .sendDockerContainerCommand(nodeId, 'remove', { containerId: name, force: true })
      .then((result) => ctx.parseResult(result))
      .catch(() => undefined);
    ctx.clearTransition(nodeId, name);
    throw new Error('Docker daemon did not return the duplicated container ID');
  }

  try {
    await ctx.accessResourceService?.ensureContainer(nodeId, name, newId, false);
    await ctx.environmentService?.copy(nodeId, sourceName, name);
    await ctx.runtimeSettingsService?.copy(nodeId, sourceName, name);
    await ctx.secretService?.copySecrets(nodeId, sourceName, name, userId);
    await ctx.auditService.log({
      action: 'docker.container.duplicate',
      userId,
      resourceType: 'docker-container',
      resourceId: newId,
      details: { nodeId, sourceId: containerId, sourceName, name, containerName: name },
    });
  } catch (error) {
    await ctx.nodeDispatch
      .sendDockerContainerCommand(nodeId, 'remove', { containerId: newId, force: true })
      .then((result) => ctx.parseResult(result))
      .catch(() => undefined);
    await ctx.environmentService?.deleteImported(nodeId, name).catch(() => undefined);
    await ctx.runtimeSettingsService?.delete(nodeId, name).catch(() => undefined);
    await ctx.secretService?.deleteImported(nodeId, name).catch(() => undefined);
    await ctx.accessResourceService?.removeContainer(nodeId, name).catch(() => undefined);
    ctx.clearTransition(nodeId, name);
    throw error;
  }

  ctx.clearTransition(nodeId, name);
  ctx.emitContainer(nodeId, name, newId, 'duplicated', { sourceName });
  return data && typeof data === 'object' ? { ...data, id: newId, name } : { id: newId, name };
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
  const currentMounts = normalizeMountDefinitionsFromInspect(inspect);
  const nextMounts =
    Object.hasOwn(config, 'mounts') || Object.hasOwn(config, 'volumes')
      ? normalizeMountDefinitionsFromConfig(config)
      : currentMounts;
  await assertManagedMountMutation({
    db: ctx.db,
    dispatch: ctx.nodeDispatch,
    parseResult: ctx.parseResult,
    nodeId,
    current: currentMounts,
    next: nextMounts,
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
    const daemonTaskId = asyncDaemonTaskId(data, 'update');
    const newRuntimeId = daemonTaskId ? '' : String(data?.Id ?? data?.id ?? '');
    if (newRuntimeId) {
      await ctx.accessResourceService?.preserveContainerRuntimeId(nodeId, name, newRuntimeId);
    }
  } catch (err) {
    await ctx.failTask(task?.id, err instanceof Error ? err.message : 'Failed to update container', nodeId, name);
    throw err;
  }
  const daemonTaskId = asyncDaemonTaskId(data, 'update');
  ctx.watchRecreateByName(
    nodeId,
    name,
    containerId,
    task?.id,
    'Container updated',
    expectedState,
    daemonTaskId ? ctx.longDockerOperationTimeoutMs + 30000 : updateTimeoutMs,
    undefined,
    daemonTaskId
  );
  await ctx.auditService.log({
    action: 'docker.container.update',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name },
  });
  if (hasImageChange) {
    const labels = (inspect?.Config?.Labels ?? {}) as Record<string, string>;
    const imageRef = imageRefWithTag(
      labels['wiolett.gateway.archive.image.reference'] || inspect?.Config?.Image || inspect?.Image,
      config.tag as string
    );
    ctx.imageCleanupService?.scheduleCleanupForContainer(nodeId, name, imageRef).catch(() => {});
  }
  return data && typeof data === 'object'
    ? { ...data, taskId: task?.id, containerId, name }
    : { taskId: task?.id, containerId, name };
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
  userId: string | null,
  options?: {
    skipImagePull?: boolean;
    skipWebhookCleanup?: boolean;
    actorScopes?: string[];
    backgroundImagePull?: boolean;
  }
) {
  await ctx.validateDockerNode(nodeId);
  await ctx.assertNotManagedDeploymentInternal(nodeId, containerId);
  if (hasRequestedGpuChange(config)) await ctx.assertDockerGpuCapability(nodeId);
  if (hasRequestedSpecificPortBindIp(config)) await ctx.assertDockerPortBindIpCapability(nodeId);
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
  const requestedImage = typeof config.image === 'string' ? config.image.trim() : '';
  const hasRequestedImage = !!requestedImage;
  const currentRuntimeProfile = inspect?.HostConfig?.Runtime === 'runsc' ? 'secure' : 'default';
  await ctx.assertDockerRuntimeProfileAvailable(nodeId, config.runtimeProfile, currentRuntimeProfile);
  assertSecureRuntimeConfiguration(config, inspect);
  if (hasRequestedGpuChange(config) && dockerGpuAttachmentFromInspect(inspect).mode === 'external') {
    throw new AppError(
      409,
      'GPU_ATTACHMENT_UNMANAGED',
      'This container has an unsupported GPU mapping. Gateway will preserve it but cannot replace it.'
    );
  }
  const recreateStopTimeout = ctx.resolveStopTimeoutFromInspect(inspect as Record<string, any>, config);
  assertDockerMountChangeAllowed({
    nodeId,
    resourceId: String(inspect?.scopeResourceId ?? ''),
    actorScopes: options?.actorScopes ?? [],
    nextConfig: config,
    currentInspect: inspect,
    useCurrentWhenNextMissing: true,
  });
  const currentMounts = normalizeMountDefinitionsFromInspect(inspect);
  const nextMounts =
    Object.hasOwn(config, 'mounts') || Object.hasOwn(config, 'volumes')
      ? normalizeMountDefinitionsFromConfig(config)
      : currentMounts;
  await assertManagedMountMutation({
    db: ctx.db,
    dispatch: ctx.nodeDispatch,
    parseResult: ctx.parseResult,
    nodeId,
    current: currentMounts,
    next: nextMounts,
  });
  await validateDockerRuntimeResourceConfig(ctx.runtimeOperationContext(), nodeId, containerId, config);
  ctx.setTransition(nodeId, name, 'recreating');
  ctx.emitTransition(nodeId, name, containerId, 'recreating');
  const task = await ctx.createTask(nodeId, containerId, name, 'recreate');

  const executeRecreate = async () => {
    try {
      // Inject decrypted values in the task so image-changing requests can return immediately.
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
      if (task?.id && ctx.taskService) {
        await ctx.taskService
          .update(task.id, {
            status: 'running',
            progress: hasRequestedImage ? 'Pulling image' : 'Recreating container',
          })
          .catch(() => {});
      }
      if (!options?.skipImagePull) {
        await pullConfigImage(ctx, nodeId, config, undefined, options?.actorScopes ?? []);
      }

      if (task?.id && ctx.taskService && hasRequestedImage) {
        await ctx.taskService.update(task.id, { status: 'running', progress: 'Recreating container' }).catch(() => {});
      }

      const result = await ctx.nodeDispatch.sendDockerContainerCommand(
        nodeId,
        'recreate',
        { containerId, configJson: JSON.stringify({ ...config, expectedState }) },
        Math.max(120000, ctx.lifecycleWatchTimeoutMs(recreateStopTimeout, 60))
      );
      const data = ctx.parseResult(result);
      const daemonTaskId = asyncDaemonTaskId(data, 'recreate');
      const newRuntimeId = daemonTaskId ? '' : String(data?.Id ?? data?.id ?? '');
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
        daemonTaskId ? ctx.longDockerOperationTimeoutMs + 30000 : ctx.lifecycleWatchTimeoutMs(recreateStopTimeout, 60),
        undefined,
        daemonTaskId
      );
      return data && typeof data === 'object'
        ? { ...data, taskId: task?.id, containerId, name }
        : { taskId: task?.id, containerId, name };
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
  };

  if (options?.backgroundImagePull && hasRequestedImage && !options.skipImagePull) {
    void executeRecreate().catch((error) => {
      logger.error('Background image recreate failed', { nodeId, containerId, name, error });
    });
    return {
      accepted: true,
      status: 'pending',
      taskId: task?.id,
      containerId,
      name,
      image: requestedImage,
    };
  }

  return executeRecreate();
}

function assertSecureRuntimeConfiguration(config: Record<string, unknown>, inspect?: Record<string, any>) {
  if (config.runtimeProfile !== 'secure') return;
  const gpu = config.gpu as { deviceIds?: unknown[] } | undefined;
  const hasRequestedGpu = Array.isArray(gpu?.deviceIds) && gpu.deviceIds.length > 0;
  const preservesGpu = gpu === undefined && inspect ? dockerGpuAttachmentFromInspect(inspect).mode !== 'none' : false;
  if (hasRequestedGpu || preservesGpu) {
    throw new AppError(409, 'SECURE_RUNTIME_GPU_UNSUPPORTED', 'Remove GPU attachments before selecting Secure Runtime');
  }
  const mounts = Array.isArray(config.mounts)
    ? config.mounts
    : Array.isArray(config.volumes)
      ? config.volumes
      : undefined;
  const hasRequestedBind = mounts?.some(
    (mount) =>
      !!mount && typeof mount === 'object' && !Array.isArray(mount) && typeof (mount as any).hostPath === 'string'
  );
  const preservesBind =
    mounts === undefined &&
    !!inspect &&
    (Array.isArray(inspect?.Mounts)
      ? inspect.Mounts.some((mount: any) => String(mount?.Type ?? mount?.type).toLowerCase() === 'bind')
      : Array.isArray(inspect?.HostConfig?.Binds) &&
        inspect.HostConfig.Binds.some((bind: unknown) => String(bind).split(':', 1)[0]?.startsWith('/')));
  if (hasRequestedBind || preservesBind) {
    throw new AppError(
      409,
      'SECURE_RUNTIME_BIND_UNSUPPORTED',
      'Remove host bind mounts before selecting Secure Runtime'
    );
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

  const inspect = await ctx.inspectContainer(nodeId, containerId);
  const runtimeEnv = envListToMap(Array.isArray(inspect?.Config?.Env) ? inspect.Config.Env : []);
  const storedEnv = ctx.environmentService ? await ctx.environmentService.getDecryptedMap(nodeId, name) : {};
  const desiredVisibleEnv = { ...runtimeEnv, ...storedEnv, ...(env ?? {}) };
  for (const key of removeEnv ?? []) delete desiredVisibleEnv[key];

  // Merge decrypted secrets into the full desired env so secrets persist across recreate.
  let mergedEnv = desiredVisibleEnv;
  if (ctx.secretService) {
    const secrets = await ctx.secretService.getDecryptedMap(nodeId, name);
    if (Object.keys(secrets).length > 0) {
      mergedEnv = { ...desiredVisibleEnv, ...secrets };
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
      { containerId, configJson: JSON.stringify({ env: mergedEnv, removeEnv, expectedState }) },
      Math.max(60000, ctx.lifecycleWatchTimeoutMs(updateStopTimeout, 60))
    );
    data = ctx.parseResult(result);
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
  const daemonTaskId = asyncDaemonTaskId(data, 'update');
  ctx.watchRecreateByName(
    nodeId,
    name,
    containerId,
    task?.id,
    'Container env updated',
    expectedState,
    daemonTaskId ? ctx.longDockerOperationTimeoutMs + 30000 : ctx.lifecycleWatchTimeoutMs(updateStopTimeout, 60),
    async () => {
      await ctx.environmentService?.replace(nodeId, name, desiredVisibleEnv);
    },
    daemonTaskId
  );
  await ctx.auditService.log({
    action: 'docker.container.env.update',
    userId,
    resourceType: 'docker-container',
    resourceId: containerId,
    details: { nodeId, name, containerName: name },
  });

  return data && typeof data === 'object'
    ? { ...data, taskId: task?.id, containerId, name }
    : { taskId: task?.id, containerId, name };
}
