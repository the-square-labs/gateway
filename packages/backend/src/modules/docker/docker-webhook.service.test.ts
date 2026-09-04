import { describe, expect, it, vi } from 'vitest';
import { DockerWebhookService } from './docker-webhook.service.js';

describe('DockerWebhookService', () => {
  it('rejects malformed bearer tokens before issuing a UUID database query', async () => {
    const select = vi.fn();
    const service = new DockerWebhookService(
      { select } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(service.getByToken('raw-secret-that-is-not-a-uuid')).resolves.toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  function createService(inspectConfig: Record<string, unknown> = {}) {
    const docker = {
      getManagedContainerConfiguration: vi.fn().mockResolvedValue(null),
      inspectContainer: vi.fn().mockResolvedValue({
        Config: {
          Image: 'registry.example.com/team/app:old',
          ...inspectConfig,
        },
        HostConfig: {},
        NetworkingConfig: {},
      }),
      requireNoTransition: vi.fn(),
      setTransition: vi.fn(),
      emitTransition: vi.fn(),
      clearTransition: vi.fn(),
      recreateWithConfig: vi.fn().mockResolvedValue({}),
      listImages: vi.fn().mockResolvedValue([]),
      listContainers: vi.fn().mockResolvedValue([]),
      removeImage: vi.fn().mockResolvedValue(undefined),
    };

    const tasks = {
      create: vi.fn().mockResolvedValue({ id: 'task-1' }),
      update: vi.fn().mockResolvedValue({}),
    };

    const dispatch = {
      sendDockerImageCommand: vi.fn().mockResolvedValue({ success: true }),
    };

    const registry = {
      resolveAuthCandidatesForImagePull: vi.fn().mockResolvedValue([
        {
          registryId: 'registry-1',
          url: 'registry.example.com',
          authJson: 'encoded-auth',
        },
      ]),
      rememberImageRegistry: vi.fn().mockResolvedValue(undefined),
    };

    const cleanup = {
      scheduleCleanupForContainer: vi.fn().mockResolvedValue(undefined),
    };

    const service = new DockerWebhookService(
      {} as never,
      docker as never,
      tasks as never,
      { log: vi.fn().mockResolvedValue({}) } as never,
      dispatch as never,
      registry as never,
      cleanup as never
    );
    const getByContainer = vi.spyOn(service, 'getByContainer').mockResolvedValue(null as never);

    return { cleanup, dispatch, docker, getByContainer, registry, service, tasks };
  }

  it.each([true, false])('updates only the canonical HA image while preserving shouldRun=%s', async (shouldRun) => {
    const { cleanup, dispatch, docker, registry, service, tasks } = createService({
      Image: '127.0.0.1:5443/gateway/availability/policy:mirror',
      Env: ['PROJECTED_SECRET=must-not-copy'],
    });
    docker.getManagedContainerConfiguration.mockResolvedValue({
      image: 'registry.example.com:5000/team/app:stable',
      nodeId: 'canonical-node',
      containerName: 'canonical-app',
      runtimeProfile: 'secure',
      shouldRun,
    });
    let finishRollout!: () => void;
    let rolloutStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      rolloutStarted = resolve;
    });
    docker.recreateWithConfig.mockImplementation(async () => {
      rolloutStarted();
      await new Promise<void>((resolve) => {
        finishRollout = resolve;
      });
      return {};
    });
    const update = service.triggerUpdate({
      nodeId: 'replica-node',
      containerId: 'replica-id',
      containerName: 'replica',
      tag: 'new',
      userId: 'actor',
    });
    await started;
    expect(tasks.update).not.toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'succeeded' }));
    expect(docker.getManagedContainerConfiguration).toHaveBeenCalledWith('replica-node', 'replica-id');
    expect(docker.recreateWithConfig).toHaveBeenCalledExactlyOnceWith(
      'canonical-node',
      'canonical-app',
      { image: 'registry.example.com:5000/team/app:new' },
      'actor',
      { waitForAvailability: true, forceAvailabilityRollout: true }
    );
    expect(tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'canonical-node',
        containerId: 'canonical-app',
        containerName: 'canonical-app',
      })
    );
    expect(docker.inspectContainer).not.toHaveBeenCalled();
    expect(docker.listContainers).not.toHaveBeenCalled();
    expect(dispatch.sendDockerImageCommand).not.toHaveBeenCalled();
    expect(registry.resolveAuthCandidatesForImagePull).not.toHaveBeenCalled();
    finishRollout();
    await expect(update).resolves.toMatchObject({ taskId: 'task-1' });
    expect(tasks.update).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'succeeded' }));
    expect(cleanup.scheduleCleanupForContainer).not.toHaveBeenCalled();
  });

  it('uses the current canonical tag and reports HA rollout failures without falling back to physical mutation', async () => {
    const { cleanup, dispatch, docker, service, tasks } = createService();
    docker.getManagedContainerConfiguration.mockResolvedValue({
      image: 'registry.example.com/team/app:stable',
      nodeId: 'node-1',
      containerName: 'app',
      shouldRun: false,
    });
    docker.recreateWithConfig.mockRejectedValue(new Error('Availability rollout failed'));
    await expect(service.triggerUpdate({ nodeId: 'node-1', containerId: 'app', containerName: 'app' })).rejects.toThrow(
      'Availability rollout failed'
    );
    expect(docker.recreateWithConfig).toHaveBeenCalledWith(
      'node-1',
      'app',
      {
        image: 'registry.example.com/team/app:stable',
      },
      null,
      { waitForAvailability: true, forceAvailabilityRollout: true }
    );
    expect(tasks.update).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'failed',
        error: 'Availability rollout failed',
      })
    );
    expect(tasks.update).not.toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'succeeded' }));
    expect(docker.inspectContainer).not.toHaveBeenCalled();
    expect(dispatch.sendDockerImageCommand).not.toHaveBeenCalled();
    expect(cleanup.scheduleCleanupForContainer).not.toHaveBeenCalled();
  });

  it.each([undefined, 'next'])('handles a digest-pinned canonical HA image with tag=%s', async (tag) => {
    const { docker, service } = createService();
    const image = `registry.example.com:5000/team/app@sha256:${'a'.repeat(64)}`;
    docker.getManagedContainerConfiguration.mockResolvedValue({
      image,
      nodeId: 'node-1',
      containerName: 'app',
      shouldRun: false,
    });
    vi.spyOn(service, 'getByToken').mockResolvedValue({
      id: 'webhook-1',
      enabled: true,
      targetType: 'container',
      nodeId: 'node-1',
      containerName: 'app',
    } as never);
    await service.triggerWebhookToken('11111111-1111-4111-8111-111111111111', tag);
    expect(docker.getManagedContainerConfiguration).toHaveBeenCalledWith('node-1', 'app');
    expect(docker.recreateWithConfig).toHaveBeenCalledWith(
      'node-1',
      'app',
      {
        image: tag ? 'registry.example.com:5000/team/app:next' : image,
      },
      null,
      { waitForAvailability: true, forceAvailabilityRollout: true }
    );
    expect(docker.inspectContainer).not.toHaveBeenCalled();
  });

  it('fails closed when canonical HA configuration cannot be resolved', async () => {
    const { docker, service, tasks } = createService();
    docker.getManagedContainerConfiguration.mockRejectedValue(new Error('Policy lookup failed'));
    await expect(service.triggerUpdate({ nodeId: 'node-1', containerId: 'app', containerName: 'app' })).rejects.toThrow(
      'Policy lookup failed'
    );
    expect(docker.inspectContainer).not.toHaveBeenCalled();
    expect(docker.recreateWithConfig).not.toHaveBeenCalled();
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it('keeps the exact legacy physical pull and recreate path when HA configuration is null', async () => {
    const { cleanup, dispatch, docker, registry, service } = createService();

    await service.triggerUpdate({
      nodeId: 'node-1',
      containerId: 'container-1',
      containerName: 'app',
      tag: 'new',
      webhookId: 'webhook-1',
    });

    expect(registry.resolveAuthCandidatesForImagePull).toHaveBeenCalledWith(
      'node-1',
      'registry.example.com/team/app:new'
    );
    expect(dispatch.sendDockerImageCommand).toHaveBeenCalledWith(
      'node-1',
      'pull',
      { imageRef: 'registry.example.com/team/app:new', registryAuthJson: 'encoded-auth' },
      600000
    );
    expect(registry.rememberImageRegistry).toHaveBeenCalledWith(
      'node-1',
      'registry.example.com/team/app:new',
      'registry-1'
    );
    expect(docker.getManagedContainerConfiguration).toHaveBeenCalledWith('node-1', 'container-1');
    expect(docker.inspectContainer).toHaveBeenCalledExactlyOnceWith('node-1', 'container-1');
    expect(docker.getManagedContainerConfiguration.mock.invocationCallOrder[0]).toBeLessThan(
      docker.inspectContainer.mock.invocationCallOrder[0]!
    );
    expect(docker.recreateWithConfig).toHaveBeenCalledExactlyOnceWith(
      'node-1',
      'container-1',
      {
        image: 'registry.example.com/team/app:new',
        cmd: undefined,
        entrypoint: undefined,
        workingDir: undefined,
        user: undefined,
        hostname: undefined,
        labels: undefined,
        exposedPorts: undefined,
        hostConfig: {},
        networkingConfig: {},
      },
      null,
      { skipImagePull: true, skipWebhookCleanup: true }
    );
    expect(cleanup.scheduleCleanupForContainer).toHaveBeenCalledExactlyOnceWith(
      'node-1',
      'app',
      'registry.example.com/team/app'
    );
  });

  it('converts Docker inspect env arrays before recreating from a webhook update', async () => {
    const { docker, service } = createService({
      Env: ['PATH=/bin', 'APP_PORT=4000', 'EMPTY=', 'NO_EQUALS'],
    });

    await service.triggerUpdate({
      nodeId: 'node-1',
      containerId: 'container-1',
      containerName: 'app',
      tag: 'new',
      webhookId: 'webhook-1',
    });

    const config = docker.recreateWithConfig.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(config.env).toEqual({
      PATH: '/bin',
      APP_PORT: '4000',
      EMPTY: '',
      NO_EQUALS: '',
    });
    expect(config.env).not.toHaveProperty('0');
  });

  it('does not introduce numeric env keys across repeated webhook updates', async () => {
    const { docker, service } = createService({
      Env: ['PATH=/bin', 'APP_PORT=4000'],
    });

    await service.triggerUpdate({
      nodeId: 'node-1',
      containerId: 'container-1',
      containerName: 'app',
      tag: 'new',
      webhookId: 'webhook-1',
    });
    await service.triggerUpdate({
      nodeId: 'node-1',
      containerId: 'container-1',
      containerName: 'app',
      tag: 'new',
      webhookId: 'webhook-1',
    });

    const recreateConfigs = docker.recreateWithConfig.mock.calls.map(
      (call) => call[2] as { env?: Record<string, string> }
    );
    expect(recreateConfigs).toHaveLength(2);
    for (const config of recreateConfigs) {
      expect(config.env).toEqual({ PATH: '/bin', APP_PORT: '4000' });
      expect(config.env).not.toHaveProperty('0');
      expect(Object.keys(config.env ?? {})).not.toContain('1');
    }
  });
});
