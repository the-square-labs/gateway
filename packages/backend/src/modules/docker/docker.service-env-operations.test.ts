import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from './docker.service.js';
import { envListToMap, normalizeEnvRecord } from './docker-env-operations.js';

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

function createService(dispatch: { sendDockerContainerCommand: ReturnType<typeof vi.fn> }) {
  return new DockerManagementService(
    dbWithOnlineDockerNode() as never,
    { log: vi.fn().mockResolvedValue(undefined) } as never,
    dispatch as never,
    { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) } as never
  );
}

function inspectResult(env: string[]) {
  return {
    success: true,
    detail: JSON.stringify({
      Id: 'container-1',
      Name: '/api',
      Config: {
        Image: 'team/api:latest',
        Env: env,
        Labels: {},
      },
    }),
  };
}

describe('DockerManagementService env operations', () => {
  it('keeps env arrays out of record normalization', () => {
    expect(normalizeEnvRecord(['PATH=/bin'])).toBeUndefined();
    expect(envListToMap(['PATH=/bin', 'APP_PORT=4000', 'EMPTY=', 'NO_EQUALS'])).toEqual({
      PATH: '/bin',
      APP_PORT: '4000',
      EMPTY: '',
      NO_EQUALS: '',
    });
  });

  it('returns stored decrypted environment when it exists', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi.fn().mockResolvedValue(inspectResult(['RUNTIME=value'])),
    };
    const environmentService = {
      getDecryptedMap: vi.fn().mockResolvedValue({ FOO: 'stored', EMPTY: '' }),
      seedFromRuntimeIfMissing: vi.fn(),
    };
    const service = createService(dispatch);
    service.setEnvironmentService(environmentService as never);

    await expect(service.getContainerEnv('node-1', 'container-1')).resolves.toEqual(['FOO=stored', 'EMPTY=']);
    expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledTimes(2);
    expect(environmentService.getDecryptedMap).toHaveBeenCalledWith('node-1', 'api');
    expect(environmentService.seedFromRuntimeIfMissing).not.toHaveBeenCalled();
  });

  it('filters secret keys from stored decrypted environment', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi.fn().mockResolvedValue(inspectResult(['PUBLIC=runtime', 'SECRET=runtime-secret'])),
    };
    const secretService = {
      getSecretKeys: vi.fn().mockResolvedValue(new Set(['SECRET'])),
    };
    const environmentService = {
      getDecryptedMap: vi.fn().mockResolvedValue({ PUBLIC: 'stored', SECRET: 'stored-secret' }),
      seedFromRuntimeIfMissing: vi.fn(),
    };
    const service = createService(dispatch);
    service.setSecretService(secretService as never);
    service.setEnvironmentService(environmentService as never);

    await expect(service.getContainerEnv('node-1', 'container-1')).resolves.toEqual(['PUBLIC=stored']);
    expect(environmentService.seedFromRuntimeIfMissing).not.toHaveBeenCalled();
  });

  it('filters secret keys before seeding missing stored environment from runtime env', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi.fn().mockResolvedValue(inspectResult(['PUBLIC=1', 'SECRET=hidden', 'NO_EQUALS'])),
    };
    const secretService = {
      getSecretKeys: vi.fn().mockResolvedValue(new Set(['SECRET'])),
    };
    const environmentService = {
      getDecryptedMap: vi.fn().mockResolvedValue({}),
      seedFromRuntimeIfMissing: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(dispatch);
    service.setSecretService(secretService as never);
    service.setEnvironmentService(environmentService as never);

    await expect(service.getContainerEnv('node-1', 'container-1')).resolves.toEqual(['PUBLIC=1', 'NO_EQUALS']);
    expect(secretService.getSecretKeys).toHaveBeenCalledWith('node-1', 'api');
    expect(environmentService.seedFromRuntimeIfMissing).toHaveBeenCalledWith('node-1', 'api', {
      PUBLIC: '1',
      NO_EQUALS: '',
    });
  });

  it('does not spread array-shaped recreate env into numeric keys when merging stored env and secrets', async () => {
    const inspect = {
      Id: 'container-1',
      Name: '/api',
      Config: {
        Image: 'team/api:latest',
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
          return { success: true, detail: JSON.stringify({ ok: true }), payload };
        }
        return { success: false, error: `unexpected action ${action}` };
      }),
    };
    const service = createService(dispatch);
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
    service.setEnvironmentService({
      getDecryptedMap: vi.fn().mockResolvedValue({ STORED: 'yes' }),
    } as never);
    service.setSecretService({
      getDecryptedMap: vi.fn().mockResolvedValue({ SECRET: 'decrypted' }),
    } as never);

    await service.recreateWithConfig(
      'node-1',
      'container-1',
      { image: 'team/api:latest', env: ['PATH=/bin'] },
      'user-1',
      { skipImagePull: true }
    );

    const recreateCall = dispatch.sendDockerContainerCommand.mock.calls.find((call) => call[1] === 'recreate');
    const config = JSON.parse((recreateCall?.[2] as { configJson: string }).configJson);
    expect(config.env).toEqual({ STORED: 'yes', SECRET: 'decrypted' });
    expect(config.env).not.toHaveProperty('0');
  });

  it('keeps valid record-shaped recreate env while merging stored env and secrets', async () => {
    const inspect = {
      Id: 'container-1',
      Name: '/api',
      Config: {
        Image: 'team/api:latest',
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
          return { success: true, detail: JSON.stringify({ ok: true }), payload };
        }
        return { success: false, error: `unexpected action ${action}` };
      }),
    };
    const service = createService(dispatch);
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
    service.setEnvironmentService({
      getDecryptedMap: vi.fn().mockResolvedValue({ STORED: 'yes', APP_PORT: 'stored' }),
    } as never);
    service.setSecretService({
      getDecryptedMap: vi.fn().mockResolvedValue({ SECRET: 'decrypted' }),
    } as never);

    await service.recreateWithConfig(
      'node-1',
      'container-1',
      { image: 'team/api:latest', env: { APP_PORT: '4000' } },
      'user-1',
      { skipImagePull: true }
    );

    const recreateCall = dispatch.sendDockerContainerCommand.mock.calls.find((call) => call[1] === 'recreate');
    const config = JSON.parse((recreateCall?.[2] as { configJson: string }).configJson);
    expect(config.env).toEqual({
      STORED: 'yes',
      APP_PORT: '4000',
      SECRET: 'decrypted',
    });
  });

  it('passes the pre-recreate running state to daemon env updates', async () => {
    const inspect = {
      Id: 'container-1',
      Name: '/api',
      Config: {
        Image: 'team/api:latest',
        Env: ['PATH=/bin'],
        Labels: {},
      },
      State: { Status: 'running' },
    };
    const dispatch = {
      sendDockerContainerCommand: vi.fn(async (_nodeId: string, action: string, payload?: Record<string, unknown>) => {
        if (action === 'inspect') {
          return { success: true, detail: JSON.stringify(inspect) };
        }
        if (action === 'update') {
          return { success: true, detail: JSON.stringify({ ok: true }), payload };
        }
        return { success: false, error: `unexpected action ${action}` };
      }),
    };
    const service = createService(dispatch);
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
    service.setEnvironmentService({
      getDecryptedMap: vi.fn().mockResolvedValue({}),
      replace: vi.fn().mockResolvedValue(undefined),
    } as never);

    await service.updateContainerEnv('node-1', 'container-1', { APP_PORT: '4000' }, undefined, 'user-1');

    const updateCall = dispatch.sendDockerContainerCommand.mock.calls.find((call) => call[1] === 'update');
    const config = JSON.parse((updateCall?.[2] as { configJson: string }).configJson);
    expect(config.expectedState).toBe('running');
  });
});
