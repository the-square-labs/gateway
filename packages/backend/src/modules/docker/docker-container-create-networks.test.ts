import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { assertCreateNetworksAccess } from './docker-container-create-networks.js';
import { DockerNetworkAccessResourceService } from './docker-network-access-resource.service.js';
import { DockerSnapshotService } from './docker-snapshot.service.js';

const NODE = '11111111-1111-4111-8111-111111111111';
const TEAM_NETWORK = { id: 'a'.repeat(64), name: 'team-net', labels: {} };
const COMPOSE_NETWORK = {
  id: 'b'.repeat(64),
  name: 'shop_default',
  labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.network': 'default' },
};

function registerNetworks() {
  container.registerInstance(DockerSnapshotService, {
    getList: vi.fn().mockResolvedValue({ revision: 1, refreshStatus: 'ok', data: [TEAM_NETWORK, COMPOSE_NETWORK] }),
  } as never);
  container.registerInstance(DockerNetworkAccessResourceService, {
    resolveNetwork: vi.fn(async (_nodeId: string, networkId: string) =>
      networkId === TEAM_NETWORK.id ? 'team-net-access' : 'shop-net-access'
    ),
  } as never);
}

afterEach(() => container.reset());

describe('container create networks', () => {
  it('needs docker:networks:edit on each requested network beyond the default ones', async () => {
    registerNetworks();
    const createOnly = [`docker:containers:create:${NODE}`];

    await expect(assertCreateNetworksAccess(createOnly, NODE, ['bridge', 'default'])).resolves.toBeUndefined();
    await expect(assertCreateNetworksAccess(createOnly, NODE, ['team-net'])).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      assertCreateNetworksAccess([...createOnly, `docker:networks:edit:${NODE}/team-net-access`], NODE, ['team-net'])
    ).resolves.toBeUndefined();
  });

  it('refuses a Compose project network even with node-wide network access', async () => {
    registerNetworks();

    await expect(
      assertCreateNetworksAccess([`docker:networks:edit:${NODE}`], NODE, ['shop_default'])
    ).rejects.toMatchObject({ statusCode: 409, code: 'COMPOSE_RESOURCE_MANAGED' });
  });
});
