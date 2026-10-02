import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from './docker.service.js';

/** A container "web" on node-1 that Availability manages (stand run x1: POST .../update changed one replica only). */
function createService() {
  const dispatch = {
    sendDockerContainerCommand: vi.fn(async (_node: string, action: string) =>
      action === 'inspect'
        ? {
            success: true,
            detail: JSON.stringify({ Name: '/web', State: { Status: 'running' }, Config: { Labels: {} } }),
          }
        : { success: true }
    ),
  };
  const limit = vi.fn().mockResolvedValue([{ id: 'node-1', type: 'docker' }]);
  const db = { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })) };
  const service = new DockerManagementService(
    db as never,
    { log: vi.fn() } as never,
    dispatch as never,
    { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) } as never
  );
  const coordinator = {
    getConfiguration: vi.fn(async (_nodeId: string, name: string) =>
      name === 'web'
        ? { image: 'registry.example/web:1.0', shouldRun: true, nodeId: 'node-1', containerName: 'web' }
        : null
    ),
    updateConfiguration: vi.fn(async () => true),
    updateEnvironment: vi.fn(async () => true),
    getEnvironment: vi.fn(async () => null),
    setRunning: vi.fn(async () => false),
  };
  service.setAvailabilityMutationCoordinator(coordinator);
  service.setWorkloadResolver({ resolveContainerRuntimeTarget: vi.fn(async () => ({}) as never) });
  return { service, dispatch, coordinator };
}

describe('container update under Availability', () => {
  it('rolls a new tag and environment out through Availability in one change, never to one replica', async () => {
    const { service, dispatch, coordinator } = createService();

    await expect(
      service.updateContainer('node-1', 'web', { tag: '1.1', env: { MODE: 'b' }, removeEnv: ['OLD'] }, 'user-1')
    ).resolves.toEqual({ availabilityManaged: true, containerId: 'web', name: 'web' });

    expect(coordinator.updateConfiguration).toHaveBeenCalledWith(
      'node-1',
      'web',
      { image: 'registry.example/web:1.1', env: { MODE: 'b' }, removeEnv: ['OLD'] },
      'user-1',
      undefined
    );
    expect(dispatch.sendDockerContainerCommand.mock.calls.map(([, action]) => action)).not.toContain('update');
  });

  it('refuses to rename a replica or change its networks', async () => {
    const { service } = createService();

    await expect(service.renameContainer('node-1', 'web', 'web-2', 'user-1')).rejects.toMatchObject({
      code: 'AVAILABILITY_PLACEMENT_MANAGED',
    });
    await expect(service.connectContainerToNetwork('node-1', 'net', 'web', 'user-1')).rejects.toMatchObject({
      code: 'AVAILABILITY_PLACEMENT_MANAGED',
    });
  });
});
