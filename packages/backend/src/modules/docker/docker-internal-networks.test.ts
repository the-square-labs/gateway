import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/created-resource-permissions.js', () => ({
  grantCreatedResourcePermissions: vi.fn().mockResolvedValue(undefined),
}));

import { DockerManagementService } from './docker.service.js';
import { isGatewayManagedDockerNetwork, isReservedGatewayNetworkName } from './docker-internal-networks.js';

// A storage link's network on a Docker node (`gateway-storage-<16 hex>`), as
// managed-storage-bindings.service creates it.
const STORAGE_LINK_NETWORK = 'gateway-storage-0123456789abcdef';

function createService(sendDockerNetworkCommand: ReturnType<typeof vi.fn>) {
  const limit = vi.fn().mockResolvedValue([{ id: 'node-1', type: 'docker' }]);
  const db = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
  };
  const dispatch = {
    sendDockerNetworkCommand,
    sendDockerContainerCommand: vi.fn().mockResolvedValue({
      success: true,
      detail: JSON.stringify({ Config: { Labels: {} } }),
    }),
  };
  const service = new DockerManagementService(
    db as never,
    { log: vi.fn().mockResolvedValue(undefined) } as never,
    dispatch as never,
    { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) } as never
  );
  service.setEventBus({ publish: vi.fn() } as never);
  return service;
}

describe('Gateway-managed Docker networks', () => {
  it('covers managed storage link networks next to Secure Links and managed database networks', () => {
    for (const name of [
      'gateway-secure-links',
      'gateway-db-79c029a3cedc4af1',
      STORAGE_LINK_NETWORK,
      'gateway-storage-11111111-1111-4111-8111-111111111111',
    ]) {
      expect(isGatewayManagedDockerNetwork(name), name).toBe(true);
    }
    // Only the exact daemon names are managed; other gateway-storage-* names stay user networks.
    for (const name of [
      'bridge',
      'frontend',
      'gateway',
      'my-gateway-storage-net',
      'gateway-storage-assets',
      'gateway-storage-0123',
    ]) {
      expect(isGatewayManagedDockerNetwork(name), name).toBe(false);
    }
  });

  it('reserves the Gateway network names for new networks', async () => {
    for (const name of ['gateway-secure-links', 'gateway-db-app', 'gateway-storage-assets', STORAGE_LINK_NETWORK]) {
      expect(isReservedGatewayNetworkName(name), name).toBe(true);
    }
    expect(isReservedGatewayNetworkName('storage-net')).toBe(false);

    const sendDockerNetworkCommand = vi.fn(async () => ({ success: true, detail: JSON.stringify({ id: 'net-1' }) }));
    const service = createService(sendDockerNetworkCommand);
    await expect(
      service.createNetwork('node-1', { name: 'gateway-storage-0123456789abcdef', driver: 'bridge' }, 'user-1')
    ).rejects.toMatchObject({ statusCode: 409, code: 'RESERVED_NETWORK_NAME' });
    expect(sendDockerNetworkCommand).not.toHaveBeenCalled();
    await expect(
      service.createNetwork('node-1', { name: 'storage-net', driver: 'bridge' }, 'user-1')
    ).resolves.toBeTruthy();
  });

  it('hides a storage link network and refuses to connect, disconnect or remove it', async () => {
    const sendDockerNetworkCommand = vi.fn(async (_nodeId: string, action: string) =>
      action === 'list'
        ? {
            success: true,
            detail: JSON.stringify([
              { Id: 'custom-1234567890ab', Name: 'frontend' },
              { Id: 'storage-1234567890ab', Name: STORAGE_LINK_NETWORK },
            ]),
          }
        : { success: true }
    );
    const service = createService(sendDockerNetworkCommand);

    await expect(service.listNetworks('node-1')).resolves.toEqual([{ Id: 'custom-1234567890ab', Name: 'frontend' }]);
    await expect(
      service.connectContainerToNetwork('node-1', 'storage-1234', 'intruder', 'user-1')
    ).rejects.toMatchObject({ statusCode: 409, code: 'MANAGED_NETWORK' });
    await expect(
      service.disconnectContainerFromNetwork('node-1', STORAGE_LINK_NETWORK, 'app', 'user-1')
    ).rejects.toMatchObject({ statusCode: 409, code: 'MANAGED_NETWORK' });
    await expect(service.removeNetwork('node-1', 'storage-1234', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'MANAGED_NETWORK',
    });
    for (const action of ['connect', 'disconnect', 'remove']) {
      expect(sendDockerNetworkCommand).not.toHaveBeenCalledWith('node-1', action, expect.anything());
    }
  });
});
