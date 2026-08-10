import { container } from '@/container.js';
import {
  ContainerCreateSchema,
  ContainerStopSchema,
  ImagePullSchema,
  NetworkConnectSchema,
  NetworkCreateSchema,
  RegistryCreateSchema,
  RegistryUpdateSchema,
  VolumeCreateSchema,
} from '@/modules/docker/docker.schemas.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import { assertDockerNodeScope } from '@/modules/docker/docker-access.middleware.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import {
  DockerDeploymentDeploySchema,
  DockerDeploymentSwitchSchema,
} from '@/modules/docker/docker-deployment.schemas.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { User } from '@/types.js';
import { inspectConsoleCommand, parseConsoleCommandResult } from './ai.console-safety.js';
import {
  compactAgentList,
  compactDockerContainerForAgent,
  compactDockerDeploymentForAgent,
  compactDockerImageForAgent,
  compactDockerNetworkForAgent,
  compactDockerVolumeForAgent,
  dockerContainerMatchesSearch,
  dockerDeploymentMatchesSearch,
  dockerImageMatchesSearch,
  dockerNetworkMatchesSearch,
  dockerVolumeMatchesSearch,
  hasRegistryHost,
} from './ai.service-helpers.js';

export const DOCKER_TOOL_NAMES = new Set([
  'create_docker_container',
  'list_docker_containers',
  'get_docker_container',
  'execute_docker_container_console_command',
  'list_docker_deployments',
  'get_docker_deployment',
  'start_docker_deployment',
  'stop_docker_deployment',
  'restart_docker_deployment',
  'kill_docker_deployment',
  'deploy_docker_deployment',
  'switch_docker_deployment_slot',
  'rollback_docker_deployment',
  'stop_docker_deployment_slot',
  'start_docker_container',
  'stop_docker_container',
  'restart_docker_container',
  'remove_docker_container',
  'rename_docker_container',
  'duplicate_docker_container',
  'get_docker_container_stats',
  'update_docker_container_image',
  'get_docker_container_logs',
  'list_docker_images',
  'pull_docker_image',
  'remove_docker_image',
  'prune_docker_images',
  'list_docker_volumes',
  'list_docker_networks',
  'manage_docker_registry',
  'manage_docker_volume',
  'manage_docker_network',
  'manage_docker_task',
]);

export interface DockerToolContext {
  dockerService: DockerManagementService;
  ensureToolScope(user: User, scope: string): void;
  ensureToolScopeForResource(user: User, baseScope: string, resourceId: string): void;
}

export async function executeDockerTool(
  context: DockerToolContext,
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const a = args as any;

  switch (toolName) {
    case 'create_docker_container': {
      const input = ContainerCreateSchema.parse({
        image: a.image,
        registryId: optionalNonEmptyString(a.registryId),
        name: a.name,
        ports: a.ports,
        volumes: a.volumes,
        env: a.env,
        networks: a.networks,
        restartPolicy: a.restartPolicy ?? 'no',
        stopTimeout: a.stopTimeout,
        labels: a.labels,
        command: a.command,
      });
      if (input.networks?.length) context.ensureToolScopeForResource(user, 'docker:networks:edit', a.nodeId);
      const data = await context.dockerService.createContainer(a.nodeId, input, user.id, user.scopes);
      const containerId = String((data as any)?.id ?? (data as any)?.Id ?? '');
      if (!containerId) throw new Error('Docker daemon did not return the created container ID');
      try {
        for (const network of input.networks?.slice(1) ?? []) {
          await context.dockerService.connectContainerToNetwork(a.nodeId, network, containerId, user.id);
        }
        await context.dockerService.startContainer(a.nodeId, containerId, user.id);
        const inspect = await context.dockerService.inspectContainer(a.nodeId, containerId);
        const name = String((inspect as any)?.Name ?? (data as any)?.name ?? '').replace(/^\//, '');
        return {
          success: true,
          message: 'Container created and started',
          data: { ...(data as object), id: containerId, name, state: (inspect as any)?.State?.Status ?? 'running' },
        };
      } catch (error) {
        try {
          await context.dockerService.rollbackCreatedContainer(
            a.nodeId,
            containerId,
            String((data as any)?.name ?? '') || undefined,
            user.id
          );
        } catch {
          // Preserve the primary orchestration error. Cleanup failures are surfaced by Docker audit/task state.
        }
        throw error;
      }
    }
    case 'list_docker_containers': {
      assertDockerNodeScope(user.scopes, 'docker:containers:view', a.nodeId);
      const containers = await context.dockerService.listContainers(a.nodeId);
      const canViewNode = hasDockerResourceScope(user.scopes, 'docker:containers:view', a.nodeId, '');
      return Array.isArray(containers)
        ? compactAgentList(
            containers
              .filter(
                (resource: any) =>
                  canViewNode ||
                  (!!resource.scopeResourceId &&
                    hasDockerResourceScope(user.scopes, 'docker:containers:view', a.nodeId, resource.scopeResourceId))
              )
              .filter((container: any) => dockerContainerMatchesSearch(container, a.search))
              .map((container: any) => compactDockerContainerForAgent(container))
          )
        : containers;
    }
    case 'get_docker_container':
      await ensureDockerContainerScope(context, user, 'docker:containers:view', a.nodeId, a.containerId);
      return context.dockerService.inspectContainer(a.nodeId, a.containerId);
    case 'execute_docker_container_console_command':
      return executeDockerContainerConsoleCommand(context, user, args);
    case 'list_docker_deployments': {
      assertDockerNodeScope(user.scopes, 'docker:containers:view', a.nodeId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const deployments = await container.resolve(DockerDeploymentService).listSummary(a.nodeId);
      return compactAgentList(
        deployments
          .filter((deployment: any) =>
            hasDockerResourceScope(user.scopes, 'docker:containers:view', a.nodeId, deployment.id)
          )
          .filter((deployment: any) => dockerDeploymentMatchesSearch(deployment, a.search))
          .map((deployment: any) => compactDockerDeploymentForAgent(deployment))
      );
    }
    case 'get_docker_deployment': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:view', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      return container.resolve(DockerDeploymentService).get(a.nodeId, a.deploymentId);
    }
    case 'start_docker_deployment': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:manage', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const data = await container.resolve(DockerDeploymentService).start(a.nodeId, a.deploymentId, user.id);
      return { success: true, message: 'Deployment started', data };
    }
    case 'stop_docker_deployment': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:manage', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const data = await container.resolve(DockerDeploymentService).stop(a.nodeId, a.deploymentId, user.id);
      return { success: true, message: 'Deployment stopped', data };
    }
    case 'restart_docker_deployment': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:manage', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const data = await container.resolve(DockerDeploymentService).restart(a.nodeId, a.deploymentId, user.id);
      return { success: true, message: 'Deployment restarted', data };
    }
    case 'kill_docker_deployment': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:manage', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const data = await container.resolve(DockerDeploymentService).kill(a.nodeId, a.deploymentId, user.id);
      return { success: true, message: 'Deployment killed', data };
    }
    case 'deploy_docker_deployment': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:manage', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const input = DockerDeploymentDeploySchema.parse(args);
      const data = await container
        .resolve(DockerDeploymentService)
        .deploy(a.nodeId, a.deploymentId, input, user.id, 'manual', user.scopes);
      return { success: true, message: 'Deployment rollout started', data };
    }
    case 'switch_docker_deployment_slot': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:manage', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const input = DockerDeploymentSwitchSchema.parse(args);
      const data = await container
        .resolve(DockerDeploymentService)
        .switchToSlot(a.nodeId, a.deploymentId, input, user.id, undefined, user.scopes);
      return { success: true, message: `Deployment switched to ${input.slot}`, data };
    }
    case 'rollback_docker_deployment': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:manage', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const data = await container
        .resolve(DockerDeploymentService)
        .rollback(a.nodeId, a.deploymentId, a.force === true, user.id, user.scopes);
      return { success: true, message: 'Deployment rolled back', data };
    }
    case 'stop_docker_deployment_slot': {
      ensureDockerDeploymentScope(context, user, 'docker:containers:manage', a.nodeId, a.deploymentId);
      const { DockerDeploymentService } = await import('@/modules/docker/docker-deployment.service.js');
      const slot = DockerDeploymentSwitchSchema.shape.slot.parse(a.slot);
      await container.resolve(DockerDeploymentService).stopSlot(a.nodeId, a.deploymentId, slot, user.id);
      return { success: true, message: `Deployment ${slot} slot stopped` };
    }
    case 'start_docker_container':
      await ensureDockerContainerScope(context, user, 'docker:containers:manage', a.nodeId, a.containerId);
      await context.dockerService.startContainer(a.nodeId, a.containerId, user.id);
      return { success: true };
    case 'stop_docker_container':
      await ensureDockerContainerScope(context, user, 'docker:containers:manage', a.nodeId, a.containerId);
      return {
        success: true,
        message: 'Container stopping',
        data: await context.dockerService.stopContainer(
          a.nodeId,
          a.containerId,
          ContainerStopSchema.parse({ timeout: a.timeout }).timeout,
          user.id
        ),
      };
    case 'restart_docker_container':
      await ensureDockerContainerScope(context, user, 'docker:containers:manage', a.nodeId, a.containerId);
      return {
        success: true,
        message: 'Container restarting',
        data: await context.dockerService.restartContainer(
          a.nodeId,
          a.containerId,
          ContainerStopSchema.parse({ timeout: a.timeout }).timeout,
          user.id
        ),
      };
    case 'remove_docker_container':
      await ensureDockerContainerScope(context, user, 'docker:containers:delete', a.nodeId, a.containerId);
      await context.dockerService.removeContainer(a.nodeId, a.containerId, a.force ?? false, user.id);
      return { success: true };
    case 'rename_docker_container':
      await ensureDockerContainerScope(context, user, 'docker:containers:edit', a.nodeId, a.containerId);
      await context.dockerService.renameContainer(a.nodeId, a.containerId, a.name, user.id);
      return { success: true };
    case 'duplicate_docker_container': {
      await ensureDockerContainerScope(context, user, 'docker:containers:view', a.nodeId, a.containerId);
      await ensureDockerContainerScope(context, user, 'docker:containers:environment', a.nodeId, a.containerId);
      await ensureDockerContainerScope(context, user, 'docker:containers:secrets', a.nodeId, a.containerId);
      const dupData = await context.dockerService.duplicateContainer(
        a.nodeId,
        a.containerId,
        a.name,
        user.id,
        user.scopes
      );
      return { success: true, message: 'Container duplicated', data: dupData };
    }
    case 'get_docker_container_stats':
      await ensureDockerContainerScope(context, user, 'docker:containers:view', a.nodeId, a.containerId);
      return context.dockerService.getContainerStats(a.nodeId, a.containerId);
    case 'update_docker_container_image': {
      await ensureDockerContainerScope(context, user, 'docker:containers:edit', a.nodeId, a.containerId);
      const inspectData = await context.dockerService.inspectContainer(a.nodeId, a.containerId);
      const currentImage: string = (inspectData as any)?.Config?.Image ?? '';
      if (!currentImage) return { error: 'Cannot determine current container image' };
      if (currentImage.includes('@') || /^[a-f0-9]{64}$/i.test(currentImage)) {
        return {
          error: 'Digest and image-ID references cannot be retagged safely; provide a tagged image reference instead',
        };
      }
      const lastColon = currentImage.lastIndexOf(':');
      const lastSlash = currentImage.lastIndexOf('/');
      const imageName = lastColon > lastSlash ? currentImage.slice(0, lastColon) : currentImage;
      const targetRef = `${imageName}:${a.imageTag}`;
      const data = await context.dockerService.recreateWithConfig(
        a.nodeId,
        a.containerId,
        { image: targetRef },
        user.id,
        {
          actorScopes: user.scopes,
        }
      );
      return { success: true, message: `Container updating to ${targetRef}`, data };
    }
    case 'get_docker_container_logs':
      await ensureDockerContainerScope(context, user, 'docker:containers:view', a.nodeId, a.containerId);
      return context.dockerService.getContainerLogs(a.nodeId, a.containerId, a.tail || 100, a.timestamps ?? false);
    case 'list_docker_images': {
      const images = await context.dockerService.listImages(a.nodeId);
      return Array.isArray(images)
        ? compactAgentList(
            images
              .filter((image: any) => dockerImageMatchesSearch(image, a.search))
              .map((image: any) => compactDockerImageForAgent(image))
          )
        : images;
    }
    case 'pull_docker_image': {
      const input = ImagePullSchema.parse({
        imageRef: a.imageRef,
        registryId: optionalNonEmptyString(a.registryId),
      });
      const { DockerRegistryService } = await import('@/modules/docker/docker-registry.service.js');
      const registryService = container.resolve(DockerRegistryService);
      const auth = await registryService.resolveAuthForImagePull(a.nodeId, input.imageRef, input.registryId, {
        actorScopes: user.scopes,
      });
      let finalImageRef = input.imageRef;
      if (auth && !hasRegistryHost(input.imageRef)) {
        finalImageRef = `${auth.url}/${input.imageRef}`;
      }
      const data = await context.dockerService.pullImage(
        a.nodeId,
        finalImageRef,
        auth?.authJson,
        user.id,
        auth?.registryId
      );
      return { success: true, message: `Pulling ${finalImageRef}`, data };
    }
    case 'remove_docker_image':
      await context.dockerService.removeImage(a.nodeId, a.imageId, a.force ?? false, user.id);
      return { success: true };
    case 'prune_docker_images': {
      const pruneData = await context.dockerService.pruneImages(a.nodeId, user.id);
      return { success: true, message: 'Unused images pruned', data: pruneData };
    }
    case 'list_docker_volumes': {
      const volumes = await context.dockerService.listVolumes(a.nodeId);
      return Array.isArray(volumes)
        ? compactAgentList(
            volumes
              .filter((volume: any) => dockerVolumeMatchesSearch(volume, a.search))
              .map((volume: any) => compactDockerVolumeForAgent(volume))
          )
        : volumes;
    }
    case 'list_docker_networks': {
      const networks = await context.dockerService.listNetworks(a.nodeId);
      return Array.isArray(networks)
        ? compactAgentList(
            networks
              .filter((network: any) => dockerNetworkMatchesSearch(network, a.search))
              .map((network: any) => compactDockerNetworkForAgent(network))
          )
        : networks;
    }
    case 'manage_docker_registry':
      return manageDockerRegistry(context, user, args);
    case 'manage_docker_volume':
      return manageDockerVolume(context, user, args);
    case 'manage_docker_network':
      return manageDockerNetwork(context, user, args);
    case 'manage_docker_task':
      return manageDockerTask(context, user, args);
    default:
      throw new Error(`Unsupported Docker tool: ${toolName}`);
  }
}

async function executeDockerContainerConsoleCommand(
  context: DockerToolContext,
  user: User,
  args: Record<string, unknown>
) {
  const nodeId = String(args.nodeId || '');
  const containerId = String(args.containerId || '');
  if (!nodeId) throw new Error('nodeId is required');
  if (!containerId) throw new Error('containerId is required');
  await ensureDockerContainerScope(context, user, 'docker:containers:console', nodeId, containerId);

  const safety = inspectConsoleCommand(args.command as string[]);
  if (safety.blocked) {
    throw new Error(safety.reason ?? 'Console command is blocked');
  }

  const result = await container.resolve(NodeDispatchService).sendDockerExecCommand(
    nodeId,
    'run',
    {
      containerId,
      command: safety.normalizedCommand,
      user: typeof args.user === 'string' ? args.user : undefined,
    },
    35000
  );
  if (!result.success) {
    throw new Error(result.error || 'Docker console command failed');
  }
  const output = parseConsoleCommandResult(result.detail);
  return {
    nodeId,
    containerId,
    command: safety.normalizedCommand,
    risky: safety.risky,
    ...output,
  };
}

async function ensureDockerContainerScope(
  context: DockerToolContext,
  user: User,
  baseScope: string,
  nodeId: string,
  containerId: string
): Promise<void> {
  const inspected = await context.dockerService.inspectContainer(nodeId, containerId);
  const resourceId = String(inspected?.scopeResourceId ?? '');
  if (!resourceId) throw new Error('PERMISSION_DENIED: Container authorization identity is unavailable');
  context.ensureToolScopeForResource(user, baseScope, `${nodeId}/${resourceId}`);
}

function ensureDockerDeploymentScope(
  context: DockerToolContext,
  user: User,
  baseScope: string,
  nodeId: string,
  deploymentId: string
): void {
  context.ensureToolScopeForResource(user, baseScope, `${nodeId}/${deploymentId}`);
}

async function manageDockerRegistry(context: DockerToolContext, user: User, args: Record<string, unknown>) {
  const a = args as any;
  const { DockerRegistryService } = await import('@/modules/docker/docker-registry.service.js');
  const registryService = container.resolve(DockerRegistryService);
  const operation = String(a.operation);
  switch (operation) {
    case 'list':
      context.ensureToolScope(user, 'docker:registries:view');
      return registryService.list(typeof a.nodeId === 'string' ? a.nodeId : undefined);
    case 'get':
      context.ensureToolScopeForResource(user, 'docker:registries:view', String(a.registryId));
      return registryService.get(String(a.registryId));
    case 'create':
      context.ensureToolScope(user, 'docker:registries:create');
      if (
        isPublicDockerHubRegistryUrl(a.url) &&
        !optionalNonEmptyString(a.username) &&
        !optionalNonEmptyString(a.password)
      ) {
        throw new Error(
          'PUBLIC_DOCKER_HUB_REGISTRY_NOT_REQUIRED: Pull public Docker Hub images without registryId; do not create a saved registry'
        );
      }
      return registryService.create(
        RegistryCreateSchema.parse({
          ...args,
          nodeId: optionalNonEmptyString(a.nodeId),
        }),
        user.id
      );
    case 'update':
      context.ensureToolScopeForResource(user, 'docker:registries:edit', String(a.registryId));
      return registryService.update(String(a.registryId), RegistryUpdateSchema.parse(args), user.id);
    case 'delete':
      context.ensureToolScopeForResource(user, 'docker:registries:delete', String(a.registryId));
      await registryService.delete(String(a.registryId), user.id);
      return { success: true };
    case 'test':
      context.ensureToolScopeForResource(user, 'docker:registries:edit', String(a.registryId));
      return registryService.testConnection(String(a.registryId), { actorScopes: user.scopes });
    case 'test_direct':
      context.ensureToolScope(user, 'docker:registries:edit');
      return registryService.testConnectionDirect(
        String(a.url),
        typeof a.username === 'string' ? a.username : undefined,
        typeof a.password === 'string' ? a.password : undefined,
        typeof a.trustedAuthRealm === 'string' ? a.trustedAuthRealm : undefined
      );
    default:
      throw new Error(`Unsupported Docker registry operation: ${operation}`);
  }
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isPublicDockerHubRegistryUrl(value: unknown): boolean {
  const raw = optionalNonEmptyString(value);
  if (!raw) return false;
  try {
    const hostname = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
    return hostname === 'docker.io' || hostname === 'index.docker.io' || hostname === 'registry-1.docker.io';
  } catch {
    return false;
  }
}

function manageDockerVolume(context: DockerToolContext, user: User, args: Record<string, unknown>) {
  const a = args as any;
  const operation = String(a.operation);
  if (operation === 'create') {
    context.ensureToolScopeForResource(user, 'docker:volumes:create', String(a.nodeId));
    const input = VolumeCreateSchema.parse(args);
    return context.dockerService.createVolume(String(a.nodeId), input, user.id);
  }
  if (operation === 'delete') {
    context.ensureToolScopeForResource(user, 'docker:volumes:delete', String(a.nodeId));
    return context.dockerService
      .removeVolume(String(a.nodeId), String(a.name), Boolean(a.force), user.id)
      .then(() => ({ success: true }));
  }
  throw new Error(`Unsupported Docker volume operation: ${operation}`);
}

async function manageDockerNetwork(context: DockerToolContext, user: User, args: Record<string, unknown>) {
  const a = args as any;
  const operation = String(a.operation);
  if (operation === 'create') {
    context.ensureToolScopeForResource(user, 'docker:networks:create', String(a.nodeId));
    const input = NetworkCreateSchema.parse(args);
    return context.dockerService.createNetwork(String(a.nodeId), input, user.id);
  }
  if (operation === 'delete') {
    context.ensureToolScopeForResource(user, 'docker:networks:delete', String(a.nodeId));
    await context.dockerService.removeNetwork(String(a.nodeId), String(a.networkId), user.id);
    return { success: true };
  }
  if (operation === 'connect') {
    context.ensureToolScopeForResource(user, 'docker:networks:edit', String(a.nodeId));
    const input = NetworkConnectSchema.parse(args);
    await context.dockerService.connectContainerToNetwork(
      String(a.nodeId),
      String(a.networkId),
      input.containerId,
      user.id
    );
    return { success: true };
  }
  if (operation === 'disconnect') {
    context.ensureToolScopeForResource(user, 'docker:networks:edit', String(a.nodeId));
    const input = NetworkConnectSchema.parse(args);
    await context.dockerService.disconnectContainerFromNetwork(
      String(a.nodeId),
      String(a.networkId),
      input.containerId,
      user.id
    );
    return { success: true };
  }
  throw new Error(`Unsupported Docker network operation: ${operation}`);
}

async function manageDockerTask(context: DockerToolContext, user: User, args: Record<string, unknown>) {
  const a = args as any;
  context.ensureToolScope(user, 'docker:tasks');
  const { DockerTaskService } = await import('@/modules/docker/docker-task.service.js');
  const taskService = container.resolve(DockerTaskService);
  if (a.operation === 'get') return taskService.get(String(a.taskId));
  if (a.operation === 'list') {
    return taskService.list({
      nodeId: typeof a.nodeId === 'string' ? a.nodeId : undefined,
      status: typeof a.status === 'string' ? a.status : undefined,
      type: typeof a.type === 'string' ? a.type : undefined,
    });
  }
  throw new Error(`Unsupported Docker task operation: ${String(a.operation)}`);
}
