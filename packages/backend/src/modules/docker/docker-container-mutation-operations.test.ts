import { describe, expect, it, vi } from 'vitest';
import {
  createContainer,
  daemonContainerCreateConfig,
  duplicateContainer,
  killContainer,
  removeContainer,
  renameContainer,
} from './docker-container-mutation-operations.js';

describe('killContainer emergency path', () => {
  it('reuses an already-authorized transition identity and kills by stable name', async () => {
    const sendDockerContainerCommand = vi.fn().mockResolvedValue({ success: true, detail: '{}' });
    const ctx = {
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertNotManagedDeploymentInternal: vi.fn().mockRejectedValue(new Error('must not run')),
      resolveContainerName: vi.fn().mockRejectedValue(new Error('container temporarily absent')),
      requireNoTransition: vi.fn(() => {
        throw new Error('must not run');
      }),
      setTransition: vi.fn(),
      emitTransition: vi.fn(),
      createTask: vi.fn().mockResolvedValue({ id: 'task-1' }),
      nodeDispatch: { sendDockerContainerCommand },
      parseResult: vi.fn(),
      failTask: vi.fn(),
      watchTransition: vi.fn(),
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
    };

    await expect(killContainer(ctx as never, 'node-1', 'app', 'SIGKILL', 'user-1', 'app')).resolves.toEqual({
      taskId: 'task-1',
      containerId: 'app',
      name: 'app',
    });

    expect(ctx.resolveContainerName).not.toHaveBeenCalled();
    expect(ctx.assertNotManagedDeploymentInternal).not.toHaveBeenCalled();
    expect(ctx.requireNoTransition).not.toHaveBeenCalled();
    expect(sendDockerContainerCommand).toHaveBeenCalledWith('node-1', 'kill', {
      containerId: 'app',
      signal: 'SIGKILL',
      configJson: JSON.stringify({ containerName: 'app', emergency: true }),
    });
  });

  it('rejects a direct kill when the target is a Gateway-owned container', async () => {
    const sendDockerContainerCommand = vi.fn().mockResolvedValue({ success: true, detail: '{}' });
    const internalError = Object.assign(new Error('Gateway internal container'), {
      code: 'GATEWAY_INTERNAL_CONTAINER',
    });
    const ctx = {
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertNotManagedDeploymentInternal: vi.fn().mockRejectedValue(internalError),
      resolveContainerName: vi.fn().mockResolvedValue('gateway-db-connector'),
      setTransition: vi.fn(),
      emitTransition: vi.fn(),
      createTask: vi.fn(),
      nodeDispatch: { sendDockerContainerCommand },
      parseResult: vi.fn(),
      failTask: vi.fn(),
      watchTransition: vi.fn(),
      auditService: { log: vi.fn() },
    };

    await expect(killContainer(ctx as never, 'node-1', 'connector-1', 'SIGKILL', 'user-1')).rejects.toMatchObject({
      code: 'GATEWAY_INTERNAL_CONTAINER',
    });

    expect(ctx.assertNotManagedDeploymentInternal).toHaveBeenCalledWith('node-1', 'connector-1');
    expect(ctx.resolveContainerName).not.toHaveBeenCalled();
    expect(sendDockerContainerCommand).not.toHaveBeenCalled();
  });
});

function unlockedDockerNodeDb() {
  const limit = vi.fn().mockResolvedValue([{ id: 'node-1', type: 'docker', serviceCreationLocked: false }]);
  const routeLimit = vi.fn().mockResolvedValue([]);
  const routeWhere = vi.fn(() => ({ limit: routeLimit }));
  const innerJoin = vi.fn(() => ({ where: routeWhere }));
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where, innerJoin }));
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
  it.each([
    'host',
    'container:shared-workload',
  ])('rejects the %s network namespace for Secure Runtime before daemon dispatch', async (network) => {
    const sendDockerContainerCommand = vi.fn();
    const ctx = {
      db: unlockedDockerNodeDb(),
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertDockerRuntimeProfileAvailable: vi.fn().mockResolvedValue(undefined),
      assertDockerGpuCapability: vi.fn(),
      assertDockerPortBindIpCapability: vi.fn(),
      nodeDispatch: { sendDockerContainerCommand },
    };

    await expect(
      createContainer(
        ctx as never,
        'node-1',
        { image: 'nginx:alpine', runtimeProfile: 'secure', networks: [network] },
        'user-1'
      )
    ).rejects.toMatchObject({ code: 'SECURE_RUNTIME_NETWORK_NAMESPACE_UNSUPPORTED' });
    expect(sendDockerContainerCommand).not.toHaveBeenCalled();
  });

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
      assertDockerRuntimeProfileAvailable: vi.fn().mockResolvedValue(undefined),
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
      assertDockerRuntimeProfileAvailable: vi.fn().mockResolvedValue(undefined),
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

describe('container name-keyed metadata lifecycle', () => {
  it('removes environment and secrets together with a deleted container', async () => {
    const environmentService = { deleteImported: vi.fn().mockResolvedValue(undefined) };
    const runtimeSettingsService = { delete: vi.fn().mockResolvedValue(undefined) };
    const secretService = { deleteImported: vi.fn().mockResolvedValue(undefined) };
    const ctx = {
      db: unlockedDockerNodeDb(),
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      nodeDispatch: { sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true, detail: '{}' }) },
      environmentService,
      runtimeSettingsService,
      secretService,
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
      resolveContainerName: vi.fn().mockResolvedValue('deleted-name'),
      requireNoTransition: vi.fn(),
      inspectContainer: vi.fn().mockResolvedValue({ State: { Status: 'exited' } }),
      folderService: { deleteContainerAssignment: vi.fn().mockResolvedValue(undefined) },
      accessResourceService: { removeContainer: vi.fn().mockResolvedValue('scope-1') },
      emitContainer: vi.fn(),
      parseResult: vi.fn(),
    };

    await removeContainer(ctx as never, 'node-1', 'container-1', false, 'user-1');

    expect(environmentService.deleteImported).toHaveBeenCalledWith('node-1', 'deleted-name');
    expect(runtimeSettingsService.delete).toHaveBeenCalledWith('node-1', 'deleted-name');
    expect(secretService.deleteImported).toHaveBeenCalledWith('node-1', 'deleted-name');
  });

  it('clears stale destination metadata before reusing a deleted name', async () => {
    const environmentService = {
      deleteImported: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
    };
    const runtimeSettingsService = {
      delete: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
    };
    const secretService = {
      deleteImported: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
    };
    const renameRuntime = vi.fn().mockResolvedValue({ success: true, detail: '{}' });
    const ctx = {
      db: unlockedDockerNodeDb(),
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      nodeDispatch: { sendDockerContainerCommand: renameRuntime },
      environmentService,
      runtimeSettingsService,
      secretService,
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
      resolveContainerName: vi.fn().mockResolvedValue('current-name'),
      requireNoTransition: vi.fn(),
      assertNameAvailable: vi.fn().mockResolvedValue(undefined),
      setTransition: vi.fn(),
      clearTransition: vi.fn(),
      folderService: {
        deleteContainerAssignment: vi.fn().mockResolvedValue(undefined),
        renameContainerAssignment: vi.fn().mockResolvedValue(undefined),
      },
      accessResourceService: {
        removeContainer: vi.fn().mockResolvedValue(undefined),
        renameContainer: vi.fn().mockResolvedValue(undefined),
      },
      emitContainer: vi.fn(),
      translateNameConflict: (error: unknown) => {
        throw error;
      },
      parseResult: vi.fn(),
    };

    await renameContainer(ctx as never, 'node-1', 'container-1', 'deleted-name', 'user-1');

    expect(environmentService.deleteImported).toHaveBeenCalledWith('node-1', 'deleted-name');
    expect(secretService.deleteImported).toHaveBeenCalledWith('node-1', 'deleted-name');
    expect(environmentService.rename).toHaveBeenCalledWith('node-1', 'current-name', 'deleted-name');
    expect(secretService.rename).toHaveBeenCalledWith('node-1', 'current-name', 'deleted-name');
    expect(environmentService.deleteImported.mock.invocationCallOrder[0]).toBeLessThan(
      renameRuntime.mock.invocationCallOrder[0]
    );
  });

  it('rolls the runtime and completed metadata back when metadata rename fails', async () => {
    const environmentService = {
      deleteImported: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
    };
    const runtimeSettingsService = {
      delete: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockRejectedValueOnce(new Error('runtime metadata unavailable')),
    };
    const renameRuntime = vi.fn().mockResolvedValue({ success: true, detail: '{}' });
    const clearTransition = vi.fn();
    const emitContainer = vi.fn();
    const ctx = {
      db: unlockedDockerNodeDb(),
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      nodeDispatch: { sendDockerContainerCommand: renameRuntime },
      environmentService,
      runtimeSettingsService,
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
      resolveContainerName: vi.fn().mockResolvedValue('current-name'),
      requireNoTransition: vi.fn(),
      assertNameAvailable: vi.fn().mockResolvedValue(undefined),
      setTransition: vi.fn(),
      clearTransition,
      emitContainer,
      translateNameConflict: (error: unknown) => {
        throw error;
      },
      parseResult: vi.fn(),
    };

    await expect(renameContainer(ctx as never, 'node-1', 'container-1', 'new-name', 'user-1')).rejects.toThrow(
      'runtime metadata unavailable'
    );

    expect(renameRuntime).toHaveBeenNthCalledWith(1, 'node-1', 'rename', {
      containerId: 'container-1',
      newName: 'new-name',
    });
    expect(renameRuntime).toHaveBeenNthCalledWith(2, 'node-1', 'rename', {
      containerId: 'container-1',
      newName: 'current-name',
    });
    expect(environmentService.rename).toHaveBeenNthCalledWith(1, 'node-1', 'current-name', 'new-name');
    expect(environmentService.rename).toHaveBeenNthCalledWith(2, 'node-1', 'new-name', 'current-name');
    expect(clearTransition).toHaveBeenCalledWith('node-1', 'new-name');
    expect(emitContainer).not.toHaveBeenCalled();
  });
});
