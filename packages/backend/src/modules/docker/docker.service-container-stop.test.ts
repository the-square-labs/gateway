import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from './docker.service.js';

function dbWithOnlineDockerNode() {
  const limit = vi.fn().mockResolvedValue([{ id: 'node-1', type: 'docker' }]);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { select: vi.fn(() => ({ from })) };
}

function inspectResult(state: string) {
  return {
    success: true,
    detail: JSON.stringify({ Name: '/api', State: { Status: state }, Config: { Labels: {}, StopTimeout: 10 } }),
  };
}

function createService(state: string) {
  const dispatch = {
    sendDockerContainerCommand: vi.fn(async (_node: string, action: string) =>
      action === 'inspect' ? inspectResult(state) : { success: true }
    ),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const eventBus = { publish: vi.fn() };
  const tasks = {
    create: vi.fn(async () => ({ id: `task-${tasks.create.mock.calls.length}` })),
    update: vi.fn().mockResolvedValue(undefined),
  };
  const service = new DockerManagementService(
    dbWithOnlineDockerNode() as never,
    audit as never,
    dispatch as never,
    { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) } as never
  );
  service.setEventBus(eventBus as never);
  service.setTaskService(tasks as never);
  return { service, dispatch, tasks, eventBus };
}

describe('DockerManagementService.stopContainer', () => {
  it.each(['created', 'exited'])('completes the stop of a %s container at once', async (state) => {
    const { service, dispatch, tasks, eventBus } = createService(state);

    await expect(service.stopContainer('node-1', 'container-1', undefined, 'user-1')).resolves.toMatchObject({
      taskId: 'task-1',
      name: 'api',
    });
    // No `stopping` transition is left behind: a second stop is accepted instead of 409 CONTAINER_BUSY.
    await expect(service.stopContainer('node-1', 'container-1', undefined, 'user-1')).resolves.toBeDefined();

    expect(dispatch.sendDockerContainerCommand.mock.calls.map(([, action]) => action)).not.toContain('stop');
    expect(tasks.update).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'succeeded' }));
    expect(eventBus.publish).toHaveBeenCalledWith(
      'docker.container.changed',
      expect.objectContaining({ name: 'api', action: 'stopped' })
    );
  });

  it('stops a running container and holds the transition until it has exited', async () => {
    vi.useFakeTimers();
    try {
      const { service, dispatch } = createService('running');

      await service.stopContainer('node-1', 'container-1', undefined, 'user-1');

      expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith(
        'node-1',
        'stop',
        expect.objectContaining({ containerId: 'container-1' })
      );
      await expect(service.stopContainer('node-1', 'container-1', undefined, 'user-1')).rejects.toMatchObject({
        code: 'CONTAINER_BUSY',
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
