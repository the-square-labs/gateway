import { describe, expect, it, vi } from 'vitest';
import {
  createContainer,
  daemonContainerCreateConfig,
  duplicateContainer,
} from './docker-container-mutation-operations.js';

function unlockedDockerNodeDb() {
  const limit = vi.fn().mockResolvedValue([{ id: 'node-1', type: 'docker', serviceCreationLocked: false }]);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { select: vi.fn(() => ({ from })) };
}

describe('daemonContainerCreateConfig', () => {
  it('serializes the API environment record to the daemon string-list contract', () => {
    const input = {
      image: 'nginx:alpine',
      env: { APP_ENV: 'e2e', EMPTY: '' },
    };

    expect(daemonContainerCreateConfig(input)).toEqual({
      image: 'nginx:alpine',
      env: ['APP_ENV=e2e', 'EMPTY='],
    });
    expect(input.env).toEqual({ APP_ENV: 'e2e', EMPTY: '' });
  });

  it('keeps the structured port contract and adds the legacy daemon mapping', () => {
    const ports = [
      { hostIp: '127.0.0.1', hostPort: 8080, containerPort: 80, protocol: 'tcp' },
      { hostIp: '0.0.0.0', hostPort: 5353, containerPort: 53, protocol: 'udp' },
    ];

    expect(daemonContainerCreateConfig({ image: 'nginx:alpine', ports })).toEqual({
      image: 'nginx:alpine',
      ports,
      port_bindings: { '80/tcp': '8080', '53/udp': '5353' },
    });
  });

  it('maps mounts, command, and the primary network without forwarding unknown API fields', () => {
    expect(
      daemonContainerCreateConfig({
        image: 'nginx:alpine',
        volumes: [
          { hostPath: '/srv/site', containerPath: '/usr/share/nginx/html', readOnly: true },
          { name: 'cache', containerPath: '/var/cache/nginx', readOnly: false },
        ],
        networks: ['frontend', 'metrics'],
        command: ['nginx', '-g', 'daemon off;'],
        restartPolicy: 'unless-stopped',
      })
    ).toEqual({
      image: 'nginx:alpine',
      binds: ['/srv/site:/usr/share/nginx/html:ro', 'cache:/var/cache/nginx'],
      network_mode: 'frontend',
      cmd: ['nginx', '-g', 'daemon off;'],
      restartPolicy: 'unless-stopped',
    });
  });
});

describe('createContainer compensation', () => {
  it('removes an auto-named runtime container when canonical identity inspection fails', async () => {
    const sendDockerContainerCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, detail: JSON.stringify({ id: 'container-1' }) })
      .mockResolvedValueOnce({ success: true, detail: '{}' });
    const ctx = {
      db: unlockedDockerNodeDb(),
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      nodeDispatch: { sendDockerContainerCommand },
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertDockerGpuCapability: vi.fn(),
      assertDockerPortBindIpCapability: vi.fn(),
      assertNameAvailable: vi.fn(),
      setTransition: vi.fn(),
      clearTransition: vi.fn(),
      inspectContainer: vi.fn().mockRejectedValue(new Error('inspect unavailable')),
      resolveContainerName: vi.fn().mockRejectedValue(new Error('inspect unavailable')),
      emitContainer: vi.fn(),
      parseResult: (result: { success: boolean; detail?: string }) => JSON.parse(result.detail || '{}'),
    };

    await expect(createContainer(ctx as never, 'node-1', { image: 'nginx:alpine' }, 'user-1')).rejects.toThrow(
      'inspect unavailable'
    );
    expect(sendDockerContainerCommand).toHaveBeenNthCalledWith(2, 'node-1', 'remove', {
      containerId: 'container-1',
      force: true,
    });
  });

  it('removes the runtime container and partial metadata when registration fails', async () => {
    const sendDockerContainerCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, detail: JSON.stringify({ id: 'container-1', name: 'app' }) })
      .mockResolvedValueOnce({ success: true, detail: '{}' });
    const environmentService = {
      replace: vi.fn(),
      deleteImported: vi.fn().mockResolvedValue(undefined),
    };
    const accessResourceService = {
      ensureContainer: vi.fn().mockRejectedValue(new Error('metadata unavailable')),
      removeContainer: vi.fn().mockResolvedValue('scope-1'),
    };
    const ctx = {
      db: unlockedDockerNodeDb(),
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      nodeDispatch: { sendDockerContainerCommand },
      environmentService,
      accessResourceService,
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertDockerGpuCapability: vi.fn(),
      assertDockerPortBindIpCapability: vi.fn(),
      assertNameAvailable: vi.fn().mockResolvedValue(undefined),
      setTransition: vi.fn(),
      clearTransition: vi.fn(),
      parseResult: (result: { success: boolean; detail?: string }) => JSON.parse(result.detail || '{}'),
    };

    await expect(
      createContainer(ctx as never, 'node-1', { name: 'app', image: 'nginx:alpine', env: { MODE: 'test' } }, 'user-1')
    ).rejects.toThrow('metadata unavailable');

    expect(sendDockerContainerCommand).toHaveBeenNthCalledWith(2, 'node-1', 'remove', {
      containerId: 'container-1',
      force: true,
    });
    expect(environmentService.deleteImported).toHaveBeenCalledWith('node-1', 'app');
    expect(accessResourceService.removeContainer).toHaveBeenCalledWith('node-1', 'app');
  });
});

describe('duplicateContainer compensation', () => {
  it('removes the stopped clone and copied metadata when a metadata copy fails', async () => {
    const sendDockerContainerCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, detail: JSON.stringify({ id: 'container-2' }) })
      .mockResolvedValueOnce({ success: true, detail: '{}' });
    const environmentService = {
      copy: vi.fn().mockResolvedValue(undefined),
      deleteImported: vi.fn().mockResolvedValue(undefined),
    };
    const runtimeSettingsService = {
      copy: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const secretService = {
      copySecrets: vi.fn().mockRejectedValue(new Error('secret copy failed')),
      deleteImported: vi.fn().mockResolvedValue(undefined),
    };
    const accessResourceService = {
      ensureContainer: vi.fn().mockResolvedValue(undefined),
      removeContainer: vi.fn().mockResolvedValue('scope-2'),
    };
    const ctx = {
      db: unlockedDockerNodeDb(),
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      nodeDispatch: { sendDockerContainerCommand },
      environmentService,
      runtimeSettingsService,
      secretService,
      accessResourceService,
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
      resolveContainerName: vi.fn().mockResolvedValue('source'),
      inspectContainer: vi.fn().mockResolvedValue({ Id: 'container-1', HostConfig: { Binds: [] } }),
      requireNoTransition: vi.fn(),
      assertNameAvailable: vi.fn().mockResolvedValue(undefined),
      setTransition: vi.fn(),
      clearTransition: vi.fn(),
      emitContainer: vi.fn(),
      translateNameConflict: (error: unknown) => {
        throw error;
      },
      parseResult: (result: { success: boolean; detail?: string }) => JSON.parse(result.detail || '{}'),
    };

    await expect(duplicateContainer(ctx as never, 'node-1', 'container-1', 'copy', 'user-1')).rejects.toThrow(
      'secret copy failed'
    );

    expect(sendDockerContainerCommand).toHaveBeenNthCalledWith(2, 'node-1', 'remove', {
      containerId: 'container-2',
      force: true,
    });
    expect(environmentService.deleteImported).toHaveBeenCalledWith('node-1', 'copy');
    expect(runtimeSettingsService.delete).toHaveBeenCalledWith('node-1', 'copy');
    expect(secretService.deleteImported).toHaveBeenCalledWith('node-1', 'copy');
    expect(accessResourceService.removeContainer).toHaveBeenCalledWith('node-1', 'copy');
  });
});
