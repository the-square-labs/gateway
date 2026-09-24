import { container } from '@/container.js';
import { hasScopeBase, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { assertComposeChildMutationAllowed } from '@/modules/docker/compose/compose-child.guard.js';
import {
  ContainerArchivePlanSchema,
  ContainerLiveUpdateSchema,
  ContainerRecreateSchema,
  ContainerUpdateSchema,
} from '@/modules/docker/docker.schemas.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import { assertDockerNodeScope } from '@/modules/docker/docker-access.middleware.js';
import { planDockerContainerArchiveImport } from '@/modules/docker/docker-container-archive-operations.js';
import {
  getDockerContainerProcesses,
  getDockerContainerStatsHistory,
  listDockerGpuUsage,
} from '@/modules/docker/docker-container-observability.js';
import {
  containerRecreateRequiredScopes,
  containerUpdateRequiredScopes,
} from '@/modules/docker/docker-container-scope-requirements.js';
import { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import { ImageCleanupUpsertSchema } from '@/modules/docker/docker-image-cleanup.schemas.js';
import { DockerImageCleanupService } from '@/modules/docker/docker-image-cleanup.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { User } from '@/types.js';
import {
  ensureDockerContainerScopes,
  ensureToolScopeForResource,
  pickDefinedArguments,
  requiredToolString,
} from './ai.docker-tool-access.js';

const RECREATE_FIELDS = [
  'image',
  'ports',
  'mounts',
  'entrypoint',
  'command',
  'workingDir',
  'user',
  'hostname',
  'labels',
  'stopTimeout',
  'restartPolicy',
  'maxRetries',
  'memoryLimit',
  'memorySwap',
  'nanoCPUs',
  'cpuShares',
  'pidsLimit',
  'gpu',
  'runtimeProfile',
] as const;
const LIVE_UPDATE_FIELDS = [
  'restartPolicy',
  'maxRetries',
  'memoryLimit',
  'memorySwap',
  'nanoCPUs',
  'cpuShares',
  'pidsLimit',
] as const;
const UPDATE_FIELDS = ['tag', 'env', 'removeEnv'] as const;

/**
 * POST /containers/:id/recreate access: docker:containers:manage, the scopes
 * containerRecreateRequiredScopes adds for the changed fields, image pull
 * access on the node when the image changes, and the Compose child guard.
 */
export async function assertDockerContainerRecreateAccess(
  dockerService: DockerManagementService,
  user: User,
  nodeId: string,
  containerId: string,
  config: Record<string, unknown>
): Promise<any> {
  const inspected = await ensureDockerContainerScopes(
    dockerService,
    user,
    ['docker:containers:manage', ...containerRecreateRequiredScopes(config)],
    nodeId,
    containerId
  );
  // The route's assertDockerCreationAccess(..., 'docker:images:pull', nodeId, undefined, 'image').
  if (typeof config.image === 'string' && !hasScopeForCreation(user.scopes, 'docker:images:pull', undefined, nodeId)) {
    throw new AppError(403, 'FORBIDDEN', 'Missing docker:images:pull for the destination node or folder');
  }
  await assertComposeChildMutationAllowed(nodeId, containerId);
  return inspected;
}

/** Mirrors the container recreate, update, live-update, top, stats-history, GPU usage, image-cleanup and archive-plan routes. */
export async function manageDockerContainerTool(
  dockerService: DockerManagementService,
  user: User,
  args: Record<string, unknown>
): Promise<unknown> {
  const operation = String(args.operation);
  const nodeId = requiredToolString(args.nodeId, 'nodeId');

  switch (operation) {
    case 'recreate': {
      const containerId = requiredToolString(args.containerId, 'containerId');
      const config = ContainerRecreateSchema.parse(pickDefinedArguments(args, RECREATE_FIELDS));
      await assertDockerContainerRecreateAccess(dockerService, user, nodeId, containerId, config);
      const data = await dockerService.recreateWithConfig(nodeId, containerId, config, user.id, {
        actorScopes: user.scopes,
        backgroundImagePull: true,
      });
      return { success: true, message: 'Container recreate accepted', data };
    }
    case 'live_update': {
      const containerId = requiredToolString(args.containerId, 'containerId');
      await ensureDockerContainerScopes(dockerService, user, ['docker:containers:edit'], nodeId, containerId);
      await assertComposeChildMutationAllowed(nodeId, containerId);
      const config = ContainerLiveUpdateSchema.parse(pickDefinedArguments(args, LIVE_UPDATE_FIELDS));
      await dockerService.liveUpdateContainer(nodeId, containerId, config, user.id);
      return { success: true };
    }
    case 'update': {
      const containerId = requiredToolString(args.containerId, 'containerId');
      const config = ContainerUpdateSchema.parse(pickDefinedArguments(args, UPDATE_FIELDS));
      await ensureDockerContainerScopes(
        dockerService,
        user,
        ['docker:containers:edit', ...containerUpdateRequiredScopes(config)],
        nodeId,
        containerId
      );
      await assertComposeChildMutationAllowed(nodeId, containerId);
      return dockerService.updateContainer(nodeId, containerId, config, user.id, user.scopes);
    }
    case 'processes': {
      const containerId = requiredToolString(args.containerId, 'containerId');
      await ensureDockerContainerScopes(dockerService, user, ['docker:containers:view'], nodeId, containerId);
      return getDockerContainerProcesses(nodeId, containerId);
    }
    case 'stats_history': {
      const containerId = requiredToolString(args.containerId, 'containerId');
      await ensureDockerContainerScopes(dockerService, user, ['docker:containers:view'], nodeId, containerId);
      return getDockerContainerStatsHistory(nodeId, containerId);
    }
    case 'gpu_usage':
      if (!hasScopeBase(user.scopes, 'docker:containers:view')) {
        throw new Error('PERMISSION_DENIED: Missing required scope docker:containers:view');
      }
      assertDockerNodeScope(user.scopes, 'docker:containers:view', nodeId);
      return listDockerGpuUsage(nodeId, user.scopes);
    case 'image_cleanup_get':
    case 'image_cleanup_upsert':
      return manageImageCleanup(dockerService, user, operation, nodeId, args);
    case 'archive_plan_import': {
      if (!hasScopeBase(user.scopes, 'docker:containers:create')) {
        throw new Error('PERMISSION_DENIED: Missing required scope docker:containers:create');
      }
      // LICENSE ENFORCEMENT: Archive operations are Personal entitlements under the project license/TOS.
      await container.resolve(LicensePolicyService).requireFeature('container-export');
      const body = ContainerArchivePlanSchema.parse(args.archiveManifest ?? {});
      return planDockerContainerArchiveImport(nodeId, body, user.scopes);
    }
    default:
      throw new Error(`Unsupported Docker container operation: ${operation}`);
  }
}

/** Container and deployment image-cleanup routes; both require docker:containers:edit on the target. */
async function manageImageCleanup(
  dockerService: DockerManagementService,
  user: User,
  operation: 'image_cleanup_get' | 'image_cleanup_upsert',
  nodeId: string,
  args: Record<string, unknown>
) {
  const cleanup = container.resolve(DockerImageCleanupService);
  const input =
    operation === 'image_cleanup_upsert'
      ? ImageCleanupUpsertSchema.parse(pickDefinedArguments(args, ['enabled', 'retentionCount']))
      : undefined;
  if (args.targetType === 'deployment') {
    const deploymentId = requiredToolString(args.deploymentId, 'deploymentId');
    ensureToolScopeForResource(user, 'docker:containers:edit', `${nodeId}/${deploymentId}`);
    await container.resolve(DockerDeploymentService).get(nodeId, deploymentId);
    return input
      ? cleanup.upsertForDeployment(nodeId, deploymentId, input)
      : cleanup.getForDeployment(nodeId, deploymentId);
  }
  const reference = requiredToolString(args.containerName ?? args.containerId, 'containerName');
  const inspected = await ensureDockerContainerScopes(
    dockerService,
    user,
    ['docker:containers:edit'],
    nodeId,
    reference
  );
  const containerName = String(inspected?.Name ?? inspected?.name ?? '').replace(/^\//, '') || reference;
  return input
    ? cleanup.upsertForContainer(nodeId, containerName, input)
    : cleanup.getForContainer(nodeId, containerName);
}
