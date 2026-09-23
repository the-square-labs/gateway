import { describe, expect, it, vi } from 'vitest';
import { dockerWebhooks, managedDatabaseBindings, managedStorageBindings } from '@/db/schema/index.js';
import {
  createContainer,
  daemonContainerCreateConfig,
  duplicateContainer,
  killContainer,
  recreateWithConfig,
  removeContainer,
  renameContainer,
  updateContainer,
  updateContainerEnv,
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
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const db: Record<string, any> = {
    select: vi.fn(() => ({ from })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn().mockImplementation(async () => {
          updates.push({ table, values });
        }),
      })),
    })),
  };
  const deletes: unknown[] = [];
  db.delete = vi.fn((table: unknown) => ({
    where: vi.fn().mockImplementation(async () => {
      deletes.push(table);
    }),
  }));
  db.transaction = vi.fn(async (callback: (tx: typeof db) => Promise<unknown>) => callback(db));
  db.updates = updates;
  db.deletes = deletes;
  return db;
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

  it('renames PostgreSQL and managed Storage link targets with the container metadata', async () => {
    const bindingDb = unlockedDockerNodeDb();
    const renameRuntime = vi.fn().mockResolvedValue({ success: true, detail: '{}' });
    const ctx = {
      db: bindingDb,
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      nodeDispatch: { sendDockerContainerCommand: renameRuntime },
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
      resolveContainerName: vi.fn().mockResolvedValue('orders-api'),
      requireNoTransition: vi.fn(),
      assertNameAvailable: vi.fn().mockResolvedValue(undefined),
      setTransition: vi.fn(),
      clearTransition: vi.fn(),
      emitContainer: vi.fn(),
      translateNameConflict: (error: unknown) => {
        throw error;
      },
      parseResult: vi.fn(),
    };

    await renameContainer(ctx as never, 'node-1', 'container-1', 'orders-v2', 'user-1');

    expect(bindingDb.transaction).toHaveBeenCalledOnce();
    expect(bindingDb.update).toHaveBeenNthCalledWith(1, managedDatabaseBindings);
    expect(bindingDb.update).toHaveBeenNthCalledWith(2, managedStorageBindings);
    expect(bindingDb.updates.slice(0, 2)).toEqual([
      { table: managedDatabaseBindings, values: expect.objectContaining({ targetResourceId: 'orders-v2' }) },
      { table: managedStorageBindings, values: expect.objectContaining({ targetResourceId: 'orders-v2' }) },
    ]);
    expect(
      bindingDb.updates.slice(0, 2).map(({ values }: { values: Record<string, unknown> }) => Object.keys(values).sort())
    ).toEqual([
      ['targetResourceId', 'updatedAt'],
      ['targetResourceId', 'updatedAt'],
    ]);
    expect(renameRuntime).toHaveBeenCalledOnce();
  });

  it('rolls the runtime back when managed link target persistence fails', async () => {
    const bindingDb = unlockedDockerNodeDb();
    bindingDb.update.mockImplementationOnce(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    }));
    bindingDb.update.mockImplementationOnce(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockRejectedValue(new Error('storage link target unavailable')) })),
    }));
    const renameRuntime = vi.fn().mockResolvedValue({ success: true, detail: '{}' });
    const ctx = {
      db: bindingDb,
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      nodeDispatch: { sendDockerContainerCommand: renameRuntime },
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
      resolveContainerName: vi.fn().mockResolvedValue('orders-api'),
      requireNoTransition: vi.fn(),
      assertNameAvailable: vi.fn().mockResolvedValue(undefined),
      setTransition: vi.fn(),
      clearTransition: vi.fn(),
      emitContainer: vi.fn(),
      translateNameConflict: (error: unknown) => {
        throw error;
      },
      parseResult: vi.fn(),
    };

    await expect(renameContainer(ctx as never, 'node-1', 'container-1', 'orders-v2', 'user-1')).rejects.toThrow(
      'storage link target unavailable'
    );

    expect(renameRuntime).toHaveBeenNthCalledWith(1, 'node-1', 'rename', {
      containerId: 'container-1',
      newName: 'orders-v2',
    });
    expect(renameRuntime).toHaveBeenNthCalledWith(2, 'node-1', 'rename', {
      containerId: 'container-1',
      newName: 'orders-api',
    });
    expect(bindingDb.transaction).toHaveBeenCalledOnce();
  });

  it.each([
    false,
    true,
  ])('attempts every metadata rollback even with an intermediate failure (%s)', async (rollbackFails) => {
    const environmentService = {
      deleteImported: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
    };
    const runtimeSettingsService = {
      delete: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
    };
    if (rollbackFails)
      runtimeSettingsService.rename
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('runtime rollback unavailable'));
    const accessResourceService = {
      removeContainer: vi.fn().mockResolvedValue(undefined),
      renameContainer: vi.fn().mockRejectedValueOnce(new Error('access metadata unavailable')),
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
      accessResourceService,
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
      'access metadata unavailable'
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
    expect(runtimeSettingsService.rename).toHaveBeenNthCalledWith(1, 'node-1', 'current-name', 'new-name');
    expect(runtimeSettingsService.rename).toHaveBeenNthCalledWith(2, 'node-1', 'new-name', 'current-name');
    expect(ctx.db.transaction).toHaveBeenCalledTimes(2);
    expect(ctx.db.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ values: expect.objectContaining({ targetResourceId: 'new-name' }) }),
        expect.objectContaining({ values: expect.objectContaining({ targetResourceId: 'current-name' }) }),
      ])
    );
    expect(clearTransition).toHaveBeenCalledWith('node-1', 'new-name');
    expect(emitContainer).not.toHaveBeenCalled();
  });
});

describe('container webhooks follow the container name', () => {
  it('deletes webhooks when the container is removed', async () => {
    const db = unlockedDockerNodeDb();
    const ctx = {
      db,
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      nodeDispatch: { sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true, detail: '{}' }) },
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
      resolveContainerName: vi.fn().mockResolvedValue('app'),
      requireNoTransition: vi.fn(),
      inspectContainer: vi.fn().mockResolvedValue({ State: { Status: 'exited' } }),
      emitContainer: vi.fn(),
      parseResult: vi.fn(),
    };

    await removeContainer(ctx as never, 'node-1', 'container-1', false, 'user-1');

    expect(db.deletes).toContain(dockerWebhooks);
  });

  it('drops stale webhooks of the new name and moves the old ones on rename', async () => {
    const db = unlockedDockerNodeDb();
    const ctx = {
      db,
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      nodeDispatch: { sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true, detail: '{}' }) },
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
      resolveContainerName: vi.fn().mockResolvedValue('old-name'),
      requireNoTransition: vi.fn(),
      assertNameAvailable: vi.fn().mockResolvedValue(undefined),
      setTransition: vi.fn(),
      clearTransition: vi.fn(),
      emitContainer: vi.fn(),
      translateNameConflict: (error: unknown) => {
        throw error;
      },
      parseResult: vi.fn(),
    };

    await renameContainer(ctx as never, 'node-1', 'container-1', 'new-name', 'user-1');

    expect(db.deletes).toContain(dockerWebhooks);
    expect(db.updates).toContainEqual({
      table: dockerWebhooks,
      values: expect.objectContaining({ containerName: 'new-name' }),
    });
  });
});

describe('createContainer network restrictions', () => {
  function networkCtx(sendDockerNetworkCommand = vi.fn()) {
    const sendDockerContainerCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, detail: JSON.stringify({ id: 'container-1', name: 'app' }) });
    return {
      db: unlockedDockerNodeDb(),
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      nodeDispatch: { sendDockerContainerCommand, sendDockerNetworkCommand },
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertDockerRuntimeProfileAvailable: vi.fn().mockResolvedValue(undefined),
      assertDockerGpuCapability: vi.fn(),
      assertDockerPortBindIpCapability: vi.fn(),
      assertNameAvailable: vi.fn().mockResolvedValue(undefined),
      setTransition: vi.fn(),
      clearTransition: vi.fn(),
      emitContainer: vi.fn(),
      parseResult: (result: { success: boolean; detail?: string }) => JSON.parse(result.detail || 'null'),
    };
  }
  const networkList = {
    success: true,
    detail: JSON.stringify([
      { Id: 'net-front', Name: 'frontend' },
      { Id: 'net-metrics', Name: 'metrics' },
      { Id: 'net-host', Name: 'host' },
      { Id: 'net-db', Name: 'gateway-db-0123456789abcdef' },
      { Id: 'net-links', Name: 'gateway-secure-links' },
    ]),
  };

  it.each([
    ['host', 'NETWORK_MODE_NOT_ALLOWED'],
    ['container:other', 'NETWORK_MODE_NOT_ALLOWED'],
    ['gateway-db-0123456789abcdef', 'MANAGED_NETWORK'],
    ['gateway-secure-links', 'MANAGED_NETWORK'],
    ['missing-network', 'DOCKER_NETWORK_NOT_FOUND'],
  ])('rejects %s before creating the container', async (network, code) => {
    const ctx = networkCtx(vi.fn().mockResolvedValue(networkList));

    await expect(
      createContainer(ctx as never, 'node-1', { name: 'app', image: 'nginx:alpine', networks: [network] }, 'user-1')
    ).rejects.toMatchObject({ code });
    expect(ctx.nodeDispatch.sendDockerContainerCommand).not.toHaveBeenCalled();
  });

  it('creates on the primary network and connects the additional networks', async () => {
    const sendDockerNetworkCommand = vi.fn(async (_nodeId: string, action: string) =>
      action === 'list' ? networkList : { success: true, detail: '{}' }
    );
    const ctx = networkCtx(sendDockerNetworkCommand);

    await createContainer(
      ctx as never,
      'node-1',
      { name: 'app', image: 'nginx:alpine', networks: ['frontend', 'metrics'] },
      'user-1'
    );

    const createCall = ctx.nodeDispatch.sendDockerContainerCommand.mock.calls[0];
    expect(JSON.parse(createCall[2].configJson)).toMatchObject({ network_mode: 'frontend' });
    expect(sendDockerNetworkCommand).toHaveBeenCalledWith('node-1', 'connect', {
      networkId: 'net-metrics',
      containerId: 'container-1',
    });
  });
});

describe('updateContainerEnv persistence', () => {
  function envCtx(overrides: Record<string, unknown> = {}) {
    const environmentService = {
      getDecryptedMap: vi.fn().mockResolvedValue({ APP_MODE: 'prod', LEGACY_SECRET: '********', API_KEY: 'stale' }),
      replace: vi.fn().mockResolvedValue(undefined),
    };
    const secretService = { getDecryptedMap: vi.fn().mockResolvedValue({ API_KEY: 'real-secret' }) };
    const sendDockerContainerCommand = vi.fn().mockResolvedValue({ success: true, detail: '{}' });
    return {
      environmentService,
      secretService,
      nodeDispatch: { sendDockerContainerCommand },
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
      resolveContainerName: vi.fn().mockResolvedValue('app'),
      resolveExpectedRecreateState: vi.fn().mockResolvedValue('running'),
      resolveContainerStopTimeout: vi.fn().mockResolvedValue(10),
      inspectContainer: vi.fn().mockResolvedValue({
        Config: { Env: ['PATH=/usr/bin', 'PG_MAJOR=15', 'API_KEY=********', 'APP_MODE=prod'] },
      }),
      requireNoTransition: vi.fn(),
      setTransition: vi.fn(),
      clearTransition: vi.fn(),
      emitTransition: vi.fn(),
      createTask: vi.fn().mockResolvedValue({ id: 'task-1' }),
      watchRecreateByName: vi.fn(),
      lifecycleWatchTimeoutMs: vi.fn().mockReturnValue(60000),
      longDockerOperationTimeoutMs: 600000,
      parseResult: (result: { success: boolean; detail?: string; error?: string }) => {
        if (!result.success) throw new Error(result.error);
        return JSON.parse(result.detail || '{}');
      },
      ...overrides,
    };
  }

  it('persists only user-set env with the mutation and never runtime defaults, masks or secrets', async () => {
    const ctx = envCtx();

    await updateContainerEnv(ctx as never, 'node-1', 'container-1', { NEW_VAR: '1' }, ['APP_MODE'], 'user-1');

    expect(ctx.environmentService.replace).toHaveBeenCalledWith('node-1', 'app', { NEW_VAR: '1' });
    expect(ctx.environmentService.replace.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.nodeDispatch.sendDockerContainerCommand.mock.invocationCallOrder[0]
    );
    const payload = JSON.parse(ctx.nodeDispatch.sendDockerContainerCommand.mock.calls[0][2].configJson);
    expect(payload.env).toEqual({ NEW_VAR: '1', API_KEY: 'real-secret' });
    expect(payload.removeEnv).toEqual(['APP_MODE']);
    // The completion watcher no longer owns persistence.
    expect(ctx.watchRecreateByName.mock.calls[0][7]).toBeUndefined();
  });

  it('starts from the runtime env when nothing is stored yet, without masks or secrets', async () => {
    const ctx = envCtx();
    ctx.environmentService.getDecryptedMap.mockResolvedValueOnce({});

    await updateContainerEnv(ctx as never, 'node-1', 'container-1', { NEW_VAR: '1' }, undefined, 'user-1');

    expect(ctx.environmentService.replace).toHaveBeenCalledWith('node-1', 'app', {
      PATH: '/usr/bin',
      PG_MAJOR: '15',
      APP_MODE: 'prod',
      NEW_VAR: '1',
    });
  });

  it('restores the previous stored env when the daemon rejects the update', async () => {
    const ctx = envCtx();
    ctx.nodeDispatch.sendDockerContainerCommand.mockResolvedValueOnce({ success: false, error: 'daemon busy' });

    await expect(
      updateContainerEnv(ctx as never, 'node-1', 'container-1', { NEW_VAR: '1' }, undefined, 'user-1')
    ).rejects.toThrow('daemon busy');

    expect(ctx.environmentService.replace).toHaveBeenLastCalledWith('node-1', 'app', {
      APP_MODE: 'prod',
      LEGACY_SECRET: '********',
      API_KEY: 'stale',
    });
  });
});

describe('recreateWithConfig runtime settings', () => {
  it('does not persist runtime settings that fail validation', async () => {
    const runtimeSettingsService = {
      get: vi.fn().mockResolvedValue(null),
      replace: vi.fn().mockResolvedValue(undefined),
    };
    const db: Record<string, any> = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([{ capabilities: { cpuCores: 1 }, lastHealthReport: null }]),
          })),
        })),
      })),
    };
    const sendDockerContainerCommand = vi.fn().mockResolvedValue({
      success: true,
      detail: JSON.stringify({ HostConfig: { Memory: 0, NanoCPUs: 0 } }),
    });
    const runtimeContext = {
      db,
      nodeDispatch: { sendDockerContainerCommand },
      nodeRegistry: { getNode: vi.fn().mockReturnValue(undefined) },
      runtimeSettingsService,
      parseResult: (result: { detail?: string }) => JSON.parse(result.detail || '{}'),
    };
    const ctx = {
      db,
      runtimeSettingsService,
      nodeDispatch: { sendDockerContainerCommand },
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
      assertDockerGpuCapability: vi.fn(),
      assertDockerPortBindIpCapability: vi.fn(),
      assertDockerRuntimeProfileAvailable: vi.fn().mockResolvedValue(undefined),
      resolveContainerName: vi.fn().mockResolvedValue('app'),
      resolveExpectedRecreateState: vi.fn().mockResolvedValue('running'),
      requireNoTransition: vi.fn(),
      inspectContainer: vi.fn().mockResolvedValue({ HostConfig: {}, Config: { Env: [] } }),
      resolveStopTimeoutFromInspect: vi.fn().mockReturnValue(10),
      runtimeOperationContext: () => runtimeContext,
      setTransition: vi.fn(),
      parseResult: runtimeContext.parseResult,
    };

    await expect(
      recreateWithConfig(ctx as never, 'node-1', 'container-1', { nanoCPUs: 64_000_000_000 }, 'user-1')
    ).rejects.toMatchObject({ code: 'INVALID_RESOURCE_LIMIT' });

    expect(runtimeSettingsService.replace).not.toHaveBeenCalled();
    expect(ctx.setTransition).not.toHaveBeenCalled();
  });
});

describe('updateContainer image changes', () => {
  it('syncs registry credentials and realigns stored env that mirrored the old image default', async () => {
    const environmentService = {
      getDecryptedMap: vi.fn().mockResolvedValue({ PG_MAJOR: '15', APP_MODE: 'prod' }),
      replace: vi.fn().mockResolvedValue(undefined),
    };
    const registryService = { syncRegistriesToNode: vi.fn().mockResolvedValue(undefined) };
    const inspectContainer = vi
      .fn()
      .mockResolvedValueOnce({ Config: { Image: 'postgres:15', Env: ['PG_MAJOR=15', 'APP_MODE=prod'], Labels: {} } })
      .mockResolvedValueOnce({ Config: { Image: 'postgres:16', Env: ['PG_MAJOR=16', 'APP_MODE=prod'] } });
    const sendDockerContainerCommand = vi.fn().mockResolvedValue({ success: true, detail: '{}' });
    const watchRecreateByName = vi.fn();
    const ctx = {
      db: unlockedDockerNodeDb(),
      environmentService,
      registryService,
      nodeDispatch: { sendDockerContainerCommand },
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      validateDockerNode: vi.fn().mockResolvedValue(undefined),
      assertNotManagedDeploymentInternal: vi.fn().mockResolvedValue(undefined),
      resolveContainerName: vi.fn().mockResolvedValue('db'),
      inspectContainer,
      resolveExpectedRecreateState: vi.fn().mockResolvedValue('running'),
      resolveStopTimeoutFromInspect: vi.fn().mockReturnValue(10),
      lifecycleWatchTimeoutMs: vi.fn().mockReturnValue(60000),
      longDockerOperationTimeoutMs: 600000,
      runtimeOperationContext: () => ({ runtimeSettingsService: undefined }),
      requireNoTransition: vi.fn(),
      setTransition: vi.fn(),
      emitTransition: vi.fn(),
      createTask: vi.fn().mockResolvedValue({ id: 'task-1' }),
      watchRecreateByName,
      parseResult: (result: { detail?: string }) => JSON.parse(result.detail || '{}'),
    };

    await updateContainer(ctx as never, 'node-1', 'container-1', { tag: '16' }, 'user-1');

    expect(registryService.syncRegistriesToNode).toHaveBeenCalledWith('node-1');
    expect(registryService.syncRegistriesToNode.mock.invocationCallOrder[0]).toBeLessThan(
      sendDockerContainerCommand.mock.invocationCallOrder[0]
    );
    // A tag-only update does not rewrite the stored env with the mutation.
    expect(environmentService.replace).not.toHaveBeenCalled();

    const onComplete = watchRecreateByName.mock.calls[0][7] as (id: string) => Promise<void>;
    await onComplete('container-2');
    expect(inspectContainer).toHaveBeenLastCalledWith('node-1', 'container-2');
    expect(environmentService.replace).toHaveBeenCalledWith('node-1', 'db', { PG_MAJOR: '16', APP_MODE: 'prod' });
  });
});
