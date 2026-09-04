import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from './docker.service.js';

function dbWithOnlineDockerNode() {
  const limit = vi.fn().mockResolvedValue([
    {
      id: 'node-1',
      type: 'docker',
    },
  ]);
  const routeLimit = vi.fn().mockResolvedValue([]);
  const routeWhere = vi.fn(() => ({ limit: routeLimit }));
  const innerJoin = vi.fn(() => ({ where: routeWhere }));
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where, innerJoin }));
  const select = vi.fn(() => ({ from }));
  return { select };
}

function inspectResult(state: string, statePatch: Record<string, unknown> = {}) {
  return {
    success: true,
    detail: JSON.stringify({
      Name: '/api',
      State: { Status: state, ...statePatch },
      Config: { Labels: {} },
    }),
  };
}

function createService(dispatch: { sendDockerContainerCommand: ReturnType<typeof vi.fn> }) {
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const eventBus = { publish: vi.fn() };
  const service = new DockerManagementService(
    dbWithOnlineDockerNode() as never,
    audit as never,
    dispatch as never,
    { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) } as never
  );
  service.setEventBus(eventBus as never);
  const accessResources = {
    removeContainer: vi.fn().mockResolvedValue('scope-resource-1'),
    cachedContainerResourceId: vi.fn().mockReturnValue(null),
  };
  service.setAccessResourceService(accessResources as never);
  return { service, audit, eventBus, accessResources };
}

describe('DockerManagementService.removeContainer', () => {
  it.each([true, false])('cleans single-mode metadata only after successful Docker removal (%s)', async (success) => {
    const dispatch = {
      sendDockerContainerCommand: vi
        .fn()
        .mockImplementation(async (_node, action) =>
          action === 'remove' ? { success, error: 'remove rejected' } : inspectResult('exited')
        ),
    };
    const { service } = createService(dispatch);
    const containerRemoved = vi.fn().mockResolvedValue(undefined);
    service.setAvailabilityMutationCoordinator({ containerRemoved } as never);
    if (success) {
      await service.removeContainer('node-1', 'container-1', false, 'user-1');
      expect(containerRemoved).toHaveBeenCalledWith('node-1', 'api');
      expect(containerRemoved.mock.invocationCallOrder[0]).toBeGreaterThan(
        dispatch.sendDockerContainerCommand.mock.invocationCallOrder.at(-1)!
      );
    } else {
      await expect(service.removeContainer('node-1', 'container-1', false, 'user-1')).rejects.toThrow();
      expect(containerRemoved).not.toHaveBeenCalled();
    }
  });
  it('rejects deleting an HA logical resource before inspecting or removing a physical replica', async () => {
    const dispatch = { sendDockerContainerCommand: vi.fn() };
    const { service, accessResources } = createService(dispatch);
    service.setWorkloadResolver({
      resolveContainerRuntimeTarget: vi.fn().mockResolvedValue({
        workload: { policy: { mode: 'replicated' } },
        nodeId: 'other-node',
        containerId: 'replica',
      }),
    } as never);
    await expect(service.removeContainer('origin', 'logical-name', false, 'user')).rejects.toMatchObject({
      code: 'AVAILABILITY_PLACEMENT_MANAGED',
    });
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalled();
    expect(accessResources.removeContainer).not.toHaveBeenCalled();
  });
  it.each([
    ['running', {}],
    ['exited', { Running: true }],
    ['paused', {}],
    ['restarting', {}],
  ])('rejects removing active containers before dispatching remove (%s)', async (state, statePatch) => {
    const dispatch = {
      sendDockerContainerCommand: vi
        .fn()
        .mockResolvedValueOnce(inspectResult(state, statePatch))
        .mockResolvedValueOnce(inspectResult(state, statePatch))
        .mockResolvedValueOnce(inspectResult(state, statePatch)),
    };
    const { service, audit, eventBus, accessResources } = createService(dispatch);

    await expect(service.removeContainer('node-1', 'container-1', true, 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONTAINER_RUNNING',
    });

    expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledTimes(3);
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalledWith('node-1', 'remove', expect.anything());
    expect(audit.log).not.toHaveBeenCalled();
    expect(accessResources.removeContainer).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalledWith('docker.container.changed', expect.anything());
  });

  it('removes stopped containers and emits the removal event', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi
        .fn()
        .mockResolvedValueOnce(inspectResult('exited'))
        .mockResolvedValueOnce(inspectResult('exited'))
        .mockResolvedValueOnce(inspectResult('exited'))
        .mockResolvedValueOnce({ success: true }),
    };
    const { service, audit, eventBus, accessResources } = createService(dispatch);

    await service.removeContainer('node-1', 'container-1', false, 'user-1');

    expect(dispatch.sendDockerContainerCommand).toHaveBeenLastCalledWith('node-1', 'remove', {
      containerId: 'container-1',
      force: false,
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.container.remove',
      userId: 'user-1',
      resourceType: 'docker-container',
      resourceId: 'container-1',
      details: { nodeId: 'node-1', name: 'api', containerName: 'api', force: false },
    });
    expect(accessResources.removeContainer).toHaveBeenCalledWith('node-1', 'api');
    expect(eventBus.publish).toHaveBeenCalledWith('docker.container.changed', {
      nodeId: 'node-1',
      id: 'container-1',
      name: 'api',
      action: 'removed',
      scopeResourceId: 'scope-resource-1',
    });
  });
});
