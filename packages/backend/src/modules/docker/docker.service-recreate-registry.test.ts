import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from './docker.service.js';

function dbWithOnlineDockerNode() {
  const limit = vi.fn().mockResolvedValue([
    {
      id: 'node-1',
      type: 'docker',
    },
  ]);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select };
}

function createService(dispatch: {
  sendDockerContainerCommand: ReturnType<typeof vi.fn>;
  sendDockerImageCommand: ReturnType<typeof vi.fn>;
}) {
  const service = new DockerManagementService(
    dbWithOnlineDockerNode() as never,
    { log: vi.fn().mockResolvedValue(undefined) } as never,
    dispatch as never,
    { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) } as never
  );
  vi.spyOn(
    service as unknown as {
      watchRecreateByName: (
        nodeId: string,
        containerName: string,
        oldContainerId: string,
        taskId: string | undefined,
        progress: string,
        expectedState: string,
        timeoutMs?: number
      ) => void;
    },
    'watchRecreateByName'
  ).mockImplementation(() => undefined);
  return service;
}

describe('DockerManagementService recreate registry auth', () => {
  it('runs the registered binding reconciliation after the replacement container is ready', async () => {
    const inspect = {
      Id: 'container-1',
      Name: '/app',
      Config: { Image: 'nginx:old', Labels: {} },
      State: { Status: 'running' },
    };
    const dispatch = {
      sendDockerContainerCommand: vi.fn(async (_nodeId: string, action: string) => {
        if (action === 'inspect') return { success: true, detail: JSON.stringify(inspect) };
        if (action === 'recreate') return { success: true, detail: JSON.stringify({ Id: 'container-2' }) };
        return { success: false, error: `unexpected action ${action}` };
      }),
      sendDockerImageCommand: vi.fn(),
    };
    const service = createService(dispatch);
    const reconcile = vi.fn().mockResolvedValue(undefined);
    service.setContainerRecreateCompletedHandler(reconcile);

    await service.recreateWithConfig('node-1', 'container-1', {}, 'user-1', { skipImagePull: true });

    const watch = vi.mocked((service as any).watchRecreateByName);
    const onComplete = watch.mock.calls[0]?.[7] as ((newContainerId: string) => Promise<void>) | undefined;
    expect(onComplete).toBeTypeOf('function');
    await onComplete?.('container-2');
    expect(reconcile).toHaveBeenCalledWith('node-1', 'container-2');
  });

  it('returns a pending task response before a replacement image finishes pulling', async () => {
    let finishPull: ((value: { success: boolean; detail: string }) => void) | undefined;
    const pullResult = new Promise<{ success: boolean; detail: string }>((resolve) => {
      finishPull = resolve;
    });
    const inspect = {
      Id: 'container-1',
      Name: '/app',
      Config: { Image: 'nginx:new', Labels: {} },
      State: { Status: 'running' },
    };
    const dispatch = {
      sendDockerContainerCommand: vi.fn(async (_nodeId: string, action: string) => {
        if (action === 'inspect') return { success: true, detail: JSON.stringify(inspect) };
        if (action === 'recreate') return { success: true, detail: JSON.stringify({ Id: 'container-2' }) };
        return { success: false, error: `unexpected action ${action}` };
      }),
      sendDockerImageCommand: vi.fn(() => pullResult),
    };
    const service = createService(dispatch);

    await expect(
      service.recreateWithConfig('node-1', 'container-1', { image: 'nginx:new' }, 'user-1', {
        backgroundImagePull: true,
      })
    ).resolves.toMatchObject({ accepted: true, status: 'pending', containerId: 'container-1', image: 'nginx:new' });
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalledWith(
      'node-1',
      'recreate',
      expect.anything(),
      expect.anything()
    );

    finishPull?.({ success: true, detail: 'nginx:new' });
    await vi.waitFor(() => {
      expect(dispatch.sendDockerContainerCommand.mock.calls.some((call) => call[1] === 'recreate')).toBe(true);
    });
  });

  it('tries matching private registry credentials until a recreate image pull succeeds', async () => {
    const inspect = {
      Id: 'container-1',
      Name: '/app',
      Config: {
        Image: 'registry.example.com/team/app:old',
        Labels: {},
      },
      State: { Status: 'running' },
    };
    const dispatch = {
      sendDockerContainerCommand: vi.fn(async (_nodeId: string, action: string, payload?: Record<string, unknown>) => {
        if (action === 'inspect') {
          return { success: true, detail: JSON.stringify(inspect) };
        }
        if (action === 'recreate') {
          return { success: true, detail: JSON.stringify({ taskId: 'daemon-task' }), payload };
        }
        return { success: false, error: `unexpected action ${action}` };
      }),
      sendDockerImageCommand: vi.fn(async (_nodeId: string, _action: string, payload: Record<string, unknown>) => {
        if (payload.registryAuthJson === 'stazion-auth') {
          return { success: true, detail: 'registry.example.com/team/app:new' };
        }
        return { success: false, error: 'pull access denied' };
      }),
    };
    const service = createService(dispatch);
    const registry = {
      resolveAuthCandidatesForImagePull: vi.fn().mockResolvedValue([
        {
          registryId: 'registry-generic',
          url: 'registry.example.com',
          authJson: 'generic-auth',
        },
        {
          registryId: 'registry-stazion',
          url: 'registry.example.com',
          authJson: 'stazion-auth',
        },
      ]),
      rememberImageRegistry: vi.fn().mockResolvedValue(undefined),
    };
    service.setRegistryService(registry as never);
    const imageCleanup = {
      scheduleCleanupForContainer: vi.fn().mockResolvedValue(undefined),
    };
    service.setImageCleanupService(imageCleanup as never);

    await service.recreateWithConfig('node-1', 'container-1', { image: 'registry.example.com/team/app:new' }, 'user-1');

    expect(registry.resolveAuthCandidatesForImagePull).toHaveBeenCalledWith(
      'node-1',
      'registry.example.com/team/app:new',
      undefined,
      { actorScopes: [] }
    );
    expect(dispatch.sendDockerImageCommand).toHaveBeenNthCalledWith(
      1,
      'node-1',
      'pull',
      { imageRef: 'registry.example.com/team/app:new', registryAuthJson: 'generic-auth' },
      600000
    );
    expect(dispatch.sendDockerImageCommand).toHaveBeenNthCalledWith(
      2,
      'node-1',
      'pull',
      { imageRef: 'registry.example.com/team/app:new', registryAuthJson: 'stazion-auth' },
      600000
    );
    const recreateCall = dispatch.sendDockerContainerCommand.mock.calls.find((call) => call[1] === 'recreate');
    expect(JSON.parse((recreateCall?.[2] as { configJson: string }).configJson)).toMatchObject({
      image: 'registry.example.com/team/app:new',
    });
    expect(registry.rememberImageRegistry).toHaveBeenCalledWith(
      'node-1',
      'registry.example.com/team/app:new',
      'registry-stazion'
    );
    expect(imageCleanup.scheduleCleanupForContainer).toHaveBeenCalledWith(
      'node-1',
      'app',
      'registry.example.com/team/app:new'
    );
  });

  it('fails recreate promptly when the replacement container exits before reaching running', async () => {
    vi.useFakeTimers();

    try {
      const dispatch = {
        sendDockerContainerCommand: vi.fn(async (_nodeId: string, action: string) => {
          if (action === 'list') {
            return {
              success: true,
              detail: JSON.stringify([
                {
                  id: 'container-2',
                  name: '/app',
                  state: 'exited',
                  status: 'Exited (127) 1 second ago',
                },
              ]),
            };
          }
          return { success: false, error: `unexpected action ${action}` };
        }),
        sendDockerImageCommand: vi.fn(),
      };
      const service = new DockerManagementService(
        dbWithOnlineDockerNode() as never,
        { log: vi.fn().mockResolvedValue(undefined) } as never,
        dispatch as never,
        { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) } as never
      );
      const update = vi.fn().mockResolvedValue(undefined);
      const publish = vi.fn();
      service.setTaskService({ update } as never);
      service.setEventBus({ publish } as never);

      (
        service as unknown as {
          watchRecreateByName: (
            nodeId: string,
            containerName: string,
            oldContainerId: string,
            taskId: string | undefined,
            progress: string,
            expectedState: string,
            timeoutMs?: number
          ) => void;
        }
      ).watchRecreateByName('node-1', 'app', 'container-1', 'task-1', 'Container recreated', 'running', 60000);

      await vi.advanceTimersByTimeAsync(2000);

      expect(update).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          status: 'failed',
          error: 'Replacement container failed to start (Exited (127) 1 second ago)',
        })
      );
      expect(publish).toHaveBeenCalledWith(
        'docker.container.changed',
        expect.objectContaining({
          nodeId: 'node-1',
          name: 'app',
          action: 'transitioning',
          transition: null,
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails recreate promptly when a stopped-container replacement exits before reaching created', async () => {
    vi.useFakeTimers();

    try {
      const dispatch = {
        sendDockerContainerCommand: vi.fn(async (_nodeId: string, action: string) => {
          if (action === 'list') {
            return {
              success: true,
              detail: JSON.stringify([
                {
                  id: 'container-2',
                  name: '/app',
                  state: 'exited',
                  status: 'Exited (0) 1 second ago',
                },
              ]),
            };
          }
          return { success: false, error: `unexpected action ${action}` };
        }),
        sendDockerImageCommand: vi.fn(),
      };
      const service = new DockerManagementService(
        dbWithOnlineDockerNode() as never,
        { log: vi.fn().mockResolvedValue(undefined) } as never,
        dispatch as never,
        { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) } as never
      );
      const update = vi.fn().mockResolvedValue(undefined);
      service.setTaskService({ update } as never);

      (
        service as unknown as {
          watchRecreateByName: (
            nodeId: string,
            containerName: string,
            oldContainerId: string,
            taskId: string | undefined,
            progress: string,
            expectedState: string,
            timeoutMs?: number
          ) => void;
        }
      ).watchRecreateByName('node-1', 'app', 'container-1', 'task-1', 'Container recreated', 'created', 60000);

      await vi.advanceTimersByTimeAsync(2000);

      expect(update).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          status: 'failed',
          error: 'Replacement container failed to start (Exited (0) 1 second ago)',
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
