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

function createService(dispatch: { sendDockerImageCommand: ReturnType<typeof vi.fn> }) {
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new DockerManagementService(
    dbWithOnlineDockerNode() as never,
    audit as never,
    dispatch as never,
    { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) } as never
  );
  return { service, audit };
}

describe('DockerManagementService image operations', () => {
  it('pulls images in the background, updates task state, remembers registry, and emits changes', async () => {
    const dispatch = {
      sendDockerImageCommand: vi.fn().mockResolvedValue({ success: true, detail: '"pulled"' }),
    };
    const { service, audit } = createService(dispatch);
    const taskService = {
      create: vi.fn().mockResolvedValue({ id: 'task-1' }),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const registryService = {
      rememberImageRegistry: vi.fn().mockResolvedValue(undefined),
    };
    const eventBus = {
      publish: vi.fn(),
    };
    service.setTaskService(taskService as never);
    service.setRegistryService(registryService as never);
    service.setEventBus(eventBus as never);

    await expect(
      service.pullImage('node-1', 'registry.example.com/app:latest', 'auth-json', 'user-1', 'registry-1')
    ).resolves.toEqual({
      taskId: 'task-1',
      message: 'Pulling registry.example.com/app:latest...',
    });

    expect(taskService.create).toHaveBeenCalledWith({
      nodeId: 'node-1',
      containerId: '',
      containerName: 'registry.example.com/app:latest',
      type: 'pull',
    });
    expect(taskService.update).toHaveBeenCalledWith('task-1', { status: 'running' });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.image.pull',
      userId: 'user-1',
      resourceType: 'docker-image',
      details: { nodeId: 'node-1', imageRef: 'registry.example.com/app:latest' },
    });
    expect(dispatch.sendDockerImageCommand).toHaveBeenCalledWith(
      'node-1',
      'pull',
      { imageRef: 'registry.example.com/app:latest', registryAuthJson: 'auth-json' },
      600000
    );
    await vi.waitFor(() =>
      expect(taskService.update).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ status: 'succeeded', progress: 'Pulled registry.example.com/app:latest' })
      )
    );
    expect(registryService.rememberImageRegistry).toHaveBeenCalledWith(
      'node-1',
      'registry.example.com/app:latest',
      'registry-1'
    );
    expect(eventBus.publish).toHaveBeenCalledWith('docker.image.changed', {
      nodeId: 'node-1',
      ref: 'registry.example.com/app:latest',
      action: 'pulled',
    });
  });

  it('pulls an image synchronously for an internal rollout before container creation', async () => {
    const dispatch = {
      sendDockerImageCommand: vi
        .fn()
        .mockResolvedValue({ success: true, detail: JSON.stringify({ status: 'pulled' }) }),
    };
    const { service } = createService(dispatch);

    await expect(
      service.pullImageImmediate('node-1', '127.0.0.1:5443/gateway/builds/source@sha256:digest')
    ).resolves.toEqual({ status: 'pulled' });
    expect(dispatch.sendDockerImageCommand).toHaveBeenCalledWith(
      'node-1',
      'pull',
      {
        imageRef: '127.0.0.1:5443/gateway/builds/source@sha256:digest',
        registryAuthJson: undefined,
      },
      600000
    );
  });

  it('removes images with audit and image change events', async () => {
    const dispatch = {
      sendDockerImageCommand: vi.fn().mockResolvedValue({ success: true }),
    };
    const { service, audit } = createService(dispatch);
    const eventBus = { publish: vi.fn() };
    service.setEventBus(eventBus as never);

    await service.removeImage('node-1', 'sha256:image', true, 'user-1');

    expect(dispatch.sendDockerImageCommand).toHaveBeenCalledWith('node-1', 'remove', {
      imageRef: 'sha256:image',
      force: true,
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.image.remove',
      userId: 'user-1',
      resourceType: 'docker-image',
      resourceId: 'sha256:image',
      details: { nodeId: 'node-1' },
    });
    expect(eventBus.publish).toHaveBeenCalledWith('docker.image.changed', {
      nodeId: 'node-1',
      ref: 'sha256:image',
      action: 'removed',
    });
  });

  it('returns prune results and emits a wildcard image change event', async () => {
    const dispatch = {
      sendDockerImageCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify({ ImagesDeleted: ['old'], SpaceReclaimed: 100 }),
      }),
    };
    const { service, audit } = createService(dispatch);
    const eventBus = { publish: vi.fn() };
    service.setEventBus(eventBus as never);

    await expect(service.pruneImages('node-1', 'user-1')).resolves.toEqual({
      ImagesDeleted: ['old'],
      SpaceReclaimed: 100,
    });

    expect(dispatch.sendDockerImageCommand).toHaveBeenCalledWith('node-1', 'prune');
    expect(audit.log).toHaveBeenCalledWith({
      action: 'docker.image.prune',
      userId: 'user-1',
      resourceType: 'docker-image',
      details: { nodeId: 'node-1' },
    });
    expect(eventBus.publish).toHaveBeenCalledWith('docker.image.changed', {
      nodeId: 'node-1',
      ref: '*',
      action: 'pruned',
    });
  });
});
