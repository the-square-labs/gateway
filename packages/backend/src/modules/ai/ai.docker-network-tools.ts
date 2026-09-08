import { container } from '@/container.js';
import { hasScope, hasScopeBase } from '@/lib/permissions.js';
import { isComposeOwnedNetwork } from '@/modules/docker/compose/compose-discovery.service.js';
import { NetworkConnectSchema, NetworkCreateSchema } from '@/modules/docker/docker.schemas.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import {
  DockerAccessResourceService,
  hasDockerResourceScope,
} from '@/modules/docker/docker-access-resource.service.js';
import { DockerNetworkAccessResourceService } from '@/modules/docker/docker-network-access-resource.service.js';
import type { User } from '@/types.js';
import { compactAgentList, compactDockerNetworkForAgent, dockerNetworkMatchesSearch } from './ai.service-helpers.js';

export async function listDockerNetworksForAgent(
  dockerService: DockerManagementService,
  user: User,
  args: { nodeId: string; search?: string }
): Promise<unknown> {
  if (!hasScopeBase(user.scopes, 'docker:networks:view')) {
    throw new Error('PERMISSION_DENIED: Missing required scope: docker:networks:view');
  }
  const networks = await dockerService.listNetworks(args.nodeId);
  const decorated = Array.isArray(networks)
    ? await dockerService.decoratePublicNetworkSnapshot(
        args.nodeId,
        networks.filter((network) => !isComposeOwnedNetwork(network))
      )
    : networks;
  const canViewNode = hasDockerResourceScope(user.scopes, 'docker:networks:view', args.nodeId, '');
  return Array.isArray(decorated)
    ? compactAgentList(
        decorated
          .filter(
            (network: any) =>
              canViewNode ||
              (!!network.scopeResourceId &&
                hasDockerResourceScope(user.scopes, 'docker:networks:view', args.nodeId, network.scopeResourceId))
          )
          .filter((network: any) => dockerNetworkMatchesSearch(network, args.search))
          .map((network: any) => compactDockerNetworkForAgent(network))
      )
    : decorated;
}

export async function manageDockerNetworkForAgent(
  dockerService: DockerManagementService,
  user: User,
  args: Record<string, unknown>
): Promise<unknown> {
  const input = args as Record<string, any>;
  const nodeId = String(input.nodeId);
  const operation = String(input.operation);
  if (operation === 'create') {
    const network = NetworkCreateSchema.parse(args);
    assertNetworkDestinationScope(user, 'docker:networks:create', nodeId, network.folderId);
    return dockerService.createNetwork(nodeId, network, user.id);
  }
  if (operation === 'delete') {
    await assertNetworkScope(user, 'docker:networks:delete', nodeId, String(input.networkId));
    await dockerService.removeNetwork(nodeId, String(input.networkId), user.id);
    return { success: true };
  }
  if (operation === 'connect' || operation === 'disconnect') {
    const network = NetworkConnectSchema.parse(args);
    await assertNetworkScope(user, 'docker:networks:edit', nodeId, String(input.networkId));
    await assertContainerEditScope(user, nodeId, network.containerId);
    if (operation === 'connect') {
      await dockerService.connectContainerToNetwork(nodeId, String(input.networkId), network.containerId, user.id);
    } else {
      await dockerService.disconnectContainerFromNetwork(nodeId, String(input.networkId), network.containerId, user.id);
    }
    return { success: true };
  }
  throw new Error(`Unsupported Docker network operation: ${operation}`);
}

function assertNetworkDestinationScope(
  user: User,
  baseScope: string,
  nodeId: string,
  folderId: string | null | undefined
): void {
  if (
    hasScope(user.scopes, baseScope) ||
    hasScope(user.scopes, `${baseScope}:${nodeId}`) ||
    (!!folderId && hasScope(user.scopes, `${baseScope}:folder/${folderId}`))
  ) {
    return;
  }
  throw new Error(`PERMISSION_DENIED: Missing required scope: ${baseScope}`);
}

async function assertNetworkScope(user: User, baseScope: string, nodeId: string, networkId: string): Promise<void> {
  if (hasDockerResourceScope(user.scopes, baseScope, nodeId, '')) return;
  const resourceId = await container.resolve(DockerNetworkAccessResourceService).resolveNetwork(nodeId, networkId);
  if (!resourceId || !hasDockerResourceScope(user.scopes, baseScope, nodeId, resourceId)) {
    throw new Error(`PERMISSION_DENIED: Missing required scope: ${baseScope}`);
  }
}

async function assertContainerEditScope(user: User, nodeId: string, containerId: string): Promise<void> {
  if (hasDockerResourceScope(user.scopes, 'docker:containers:edit', nodeId, '')) return;
  const resources = container.resolve(DockerAccessResourceService);
  const resourceId =
    (await resources.resolveContainer(nodeId, { runtimeId: containerId })) ??
    (await resources.resolveContainer(nodeId, { name: containerId }));
  if (!resourceId || !hasDockerResourceScope(user.scopes, 'docker:containers:edit', nodeId, resourceId)) {
    throw new Error('PERMISSION_DENIED: Missing required scope: docker:containers:edit');
  }
}
