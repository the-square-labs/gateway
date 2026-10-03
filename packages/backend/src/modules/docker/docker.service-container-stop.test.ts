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

function createService(initialState: string) {
  let state = initialState;
  const dispatch = {
    sendDockerContainerCommand: vi.fn(
      async (_node: string, action: string): Promise<{ success: boolean; detail?: string; error?: string }> =>
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
  const setState = (next: string) => {
    state = next;
  };
  return { service, dispatch, tasks, eventBus, setState };
}

/** Records when a promise settled, so a test can tell an answer that has not come yet. */
function track<T>(promise: Promise<T>) {
  const tracked = { settled: false, promise };
  promise.then(
    () => {
      tracked.settled = true;
    },
    () => {
      tracked.settled = true;
    }
  );
  return tracked;
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

  it('answers the stop of a running container once it has exited', async () => {
    vi.useFakeTimers();
    try {
      const { service, dispatch, tasks, setState } = createService('running');

      const stop = track(service.stopContainer('node-1', 'container-1', undefined, 'user-1'));
      await vi.advanceTimersByTimeAsync(4000);

      expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith(
        'node-1',
        'stop',
        expect.objectContaining({ containerId: 'container-1' })
      );
      expect(stop.settled).toBe(false);
      expect(service.getContainerTransition('node-1', 'api')).toBe('stopping');

      setState('exited');
      await vi.advanceTimersByTimeAsync(2000);

      await expect(stop.promise).resolves.toMatchObject({ taskId: 'task-1', name: 'api' });
      expect(tasks.update).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'succeeded' }));
      expect(service.getContainerTransition('node-1', 'api')).toBeUndefined();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('lets a second stop wait for the stop under way and answer with it', async () => {
    vi.useFakeTimers();
    try {
      const { service, dispatch, setState } = createService('running');

      const first = track(service.stopContainer('node-1', 'container-1', undefined, 'user-1'));
      await vi.advanceTimersByTimeAsync(0);
      const second = track(service.stopContainer('node-1', 'container-1', undefined, 'user-1'));
      await vi.advanceTimersByTimeAsync(2000);
      expect(second.settled).toBe(false);

      setState('exited');
      await vi.advanceTimersByTimeAsync(2000);

      await expect(first.promise).resolves.toMatchObject({ name: 'api' });
      await expect(second.promise).resolves.toMatchObject({ name: 'api' });
      expect(dispatch.sendDockerContainerCommand.mock.calls.filter(([, action]) => action === 'stop')).toHaveLength(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('answers 504 naming the task when the container has not stopped in time', async () => {
    vi.useFakeTimers();
    try {
      const { service, tasks } = createService('running');

      const stop = service.stopContainer('node-1', 'container-1', 10, 'user-1');
      const rejected = expect(stop).rejects.toMatchObject({
        statusCode: 504,
        code: 'CONTAINER_OPERATION_TIMEOUT',
        details: { taskId: 'task-1' },
      });
      await vi.advanceTimersByTimeAsync(62_000);
      await rejected;

      expect(tasks.update).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'failed' }));
      expect(service.getContainerTransition('node-1', 'api')).toBeUndefined();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('completes a stop whose container is gone once the stop ended it', async () => {
    vi.useFakeTimers();
    try {
      const { service, dispatch } = createService('running');

      const stop = track(service.stopContainer('node-1', 'container-1', undefined, 'user-1'));
      await vi.advanceTimersByTimeAsync(0);
      dispatch.sendDockerContainerCommand.mockResolvedValue({
        success: false,
        error: 'No such container: container-1',
      });
      await vi.advanceTimersByTimeAsync(2000);

      await expect(stop.promise).resolves.toMatchObject({ name: 'api' });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe('DockerManagementService.restartContainer', () => {
  it('answers once Docker has started the container again, even when it exits at once', async () => {
    vi.useFakeTimers();
    try {
      let startedAt = '2026-10-01T10:00:00Z';
      let status = 'running';
      const { service, dispatch } = createService('running');
      dispatch.sendDockerContainerCommand.mockImplementation(async (_node: string, action: string) =>
        action === 'inspect'
          ? {
              success: true,
              detail: JSON.stringify({ Name: '/api', State: { Status: status, StartedAt: startedAt }, Config: {} }),
            }
          : { success: true }
      );

      const restart = track(service.restartContainer('node-1', 'container-1', undefined, 'user-1'));
      await vi.advanceTimersByTimeAsync(2000);
      expect(restart.settled).toBe(false);

      startedAt = '2026-10-01T10:05:00Z';
      status = 'exited';
      await vi.advanceTimersByTimeAsync(2000);

      await expect(restart.promise).resolves.toMatchObject({ name: 'api' });
      expect(service.getContainerTransition('node-1', 'api')).toBeUndefined();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe('DockerManagementService.killContainer', () => {
  it('answers SIGKILL once the container has exited', async () => {
    vi.useFakeTimers();
    try {
      const { service, setState } = createService('running');

      const kill = track(service.killContainer('node-1', 'container-1', 'SIGKILL', 'user-1'));
      await vi.advanceTimersByTimeAsync(2000);
      expect(kill.settled).toBe(false);

      setState('exited');
      await vi.advanceTimersByTimeAsync(2000);

      await expect(kill.promise).resolves.toMatchObject({ name: 'api' });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('completes another signal once it was delivered, without waiting for an exit', async () => {
    const { service, tasks } = createService('running');

    await expect(service.killContainer('node-1', 'container-1', 'SIGHUP', 'user-1')).resolves.toMatchObject({
      taskId: 'task-1',
      name: 'api',
    });

    expect(tasks.update).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'succeeded', progress: 'Sent SIGHUP' })
    );
    expect(service.getContainerTransition('node-1', 'api')).toBeUndefined();
  });
});
