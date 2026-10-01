import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import { manageDockerNetworkForAgent } from './ai.docker-network-tools.js';

const NODE = '11111111-1111-4111-8111-111111111111';
const COMPOSE_NETWORK = {
  id: 'b'.repeat(64),
  name: 'shop_default',
  labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.network': 'default' },
};

afterEach(() => container.reset());

describe('manage_docker_network', () => {
  it('applies the REST Compose guard: a Compose project network is not deleted outside its project', async () => {
    container.registerInstance(DockerSnapshotService, {
      getList: vi.fn().mockResolvedValue({ revision: 1, refreshStatus: 'ok', data: [COMPOSE_NETWORK] }),
    } as never);
    const docker = { removeNetwork: vi.fn() };
    const user = { id: 'user-1', scopes: [`docker:networks:delete:${NODE}`] };

    await expect(
      manageDockerNetworkForAgent(docker as never, user as never, {
        operation: 'delete',
        nodeId: NODE,
        networkId: COMPOSE_NETWORK.id,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'COMPOSE_RESOURCE_MANAGED' });
    expect(docker.removeNetwork).not.toHaveBeenCalled();
  });
});
