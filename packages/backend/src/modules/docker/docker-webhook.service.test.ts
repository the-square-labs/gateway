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

    return { cleanup, dispatch, docker, getByContainer, registry, service };
  }

  it('passes resolved registry auth to webhook image pulls', async () => {
    const { dispatch, docker, registry, service } = createService();

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
    expect(docker.recreateWithConfig).toHaveBeenCalledWith(
      'node-1',
      'container-1',
      expect.objectContaining({ image: 'registry.example.com/team/app:new' }),
      null,
      { skipImagePull: true, skipWebhookCleanup: true }
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
