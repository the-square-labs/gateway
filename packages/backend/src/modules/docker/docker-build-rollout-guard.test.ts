import { describe, expect, it, vi } from 'vitest';
import { DockerManagementService } from './docker.service.js';
import {
  type ActiveDockerBuildRollout,
  DockerBuildRolloutGuard,
  runAsDockerBuildRollout,
} from './docker-build-rollout-guard.js';

const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';

function rollout(overrides: Partial<ActiveDockerBuildRollout> = {}): ActiveDockerBuildRollout {
  return {
    buildId: 'build-1',
    commitSha: COMMIT,
    sourceBindingId: 'source-1',
    targetKind: 'container',
    nodeId: 'node-1',
    containerName: 'api',
    deploymentId: null,
    composeProjectId: null,
    ...overrides,
  };
}

/** The guard reads `deploying` builds with a live lease; this stands in for that query. */
function guardDb(rows: () => ActiveDockerBuildRollout[]) {
  const where = vi.fn(async () => rows());
  return {
    db: { select: () => ({ from: () => ({ innerJoin: () => ({ where }) }) }) },
    where,
  };
}

function nodeDb() {
  const limit = vi.fn().mockResolvedValue([{ id: 'node-1', type: 'docker' }]);
  return { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })) };
}

function inspect(env: string[]) {
  return {
    Id: 'container-1',
    Name: '/api',
    Config: { Image: 'team/api:1', Env: env, Labels: {} },
    State: { Status: 'running', Running: true },
  };
}

function createService(rows: () => ActiveDockerBuildRollout[]) {
  const dispatch = {
    sendDockerContainerCommand: vi.fn(async (_nodeId: string, action: string) => {
      if (action === 'inspect') return { success: true, detail: JSON.stringify(inspect(['FROM_IMAGE=1'])) };
      if (action === 'update' || action === 'recreate') return { success: true, detail: JSON.stringify({ ok: true }) };
      return { success: false, error: `unexpected action ${action}` };
    }),
  };
  const service = new DockerManagementService(
    nodeDb() as never,
    { log: vi.fn().mockResolvedValue(undefined) } as never,
    dispatch as never,
    { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) } as never
  );
  vi.spyOn(service as any, 'watchRecreateByName').mockImplementation((() => undefined) as never);
  // Stored env is the desired state; recreate reads it when it runs.
  const stored = new Map<string, Record<string, string>>([['api', { APP_MODE: 'old' }]]);
  const environment = {
    getDecryptedMap: vi.fn(async (_nodeId: string, name: string) => ({ ...(stored.get(name) ?? {}) })),
    replace: vi.fn(async (_nodeId: string, name: string, env: Record<string, string>) => {
      stored.set(name, { ...env });
    }),
  };
  service.setEnvironmentService(environment as never);
  service.setBuildRolloutGuard(new DockerBuildRolloutGuard(guardDb(rows).db as never));
  return { service, dispatch, environment, stored };
}

function dispatchedConfig(dispatch: { sendDockerContainerCommand: ReturnType<typeof vi.fn> }, action: string) {
  const call = dispatch.sendDockerContainerCommand.mock.calls.find((candidate) => candidate[1] === action);
  return call ? JSON.parse((call[2] as { configJson: string }).configJson) : undefined;
}

describe('DockerBuildRolloutGuard', () => {
  it('admits only the owning rollout and the other builds of its source', async () => {
    const rows = [
      rollout(),
      rollout({ buildId: 'build-2', sourceBindingId: 'source-1' }),
      rollout({ buildId: 'build-3', sourceBindingId: 'source-2', containerName: 'web' }),
    ];
    const guard = new DockerBuildRolloutGuard(guardDb(() => rows).db as never);

    await expect(guard.active()).resolves.toHaveLength(3);
    await expect(runAsDockerBuildRollout('build-1', () => guard.active())).resolves.toEqual([rows[2]]);
    await expect(
      runAsDockerBuildRollout('build-1', () =>
        guard.assertAllowed({ kind: 'container', nodeId: 'node-1', containerName: 'api' })
      )
    ).resolves.toBeUndefined();
  });

  it('names the build in the conflict and marks it retryable', async () => {
    const guard = new DockerBuildRolloutGuard(
      guardDb(() => [rollout({ targetKind: 'deployment', deploymentId: 'dep-1', containerName: null })]).db as never
    );
    await expect(guard.assertAllowed({ kind: 'deployment', deploymentId: 'dep-1' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BUILD_ROLLOUT_IN_PROGRESS',
      message: 'A deployment of build abcdef0123 is in progress for this deployment; try again when it finishes',
      details: { buildId: 'build-1', commitSha: COMMIT, retryable: true },
    });
    await expect(guard.assertAllowed({ kind: 'deployment', deploymentId: 'dep-2' })).resolves.toBeUndefined();
  });

  it('does not resolve container identities when no container rollout is active', async () => {
    const guard = new DockerBuildRolloutGuard(guardDb(() => []).db as never);
    const resolve = vi.fn();
    await guard.assertContainerAllowed(resolve);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('DockerManagementService while a build rollout owns the container', () => {
  it('refuses an env update with 409 and leaves stored env and the runtime untouched', async () => {
    const { service, dispatch, environment, stored } = createService(() => [rollout()]);

    await expect(
      service.updateContainerEnv('node-1', 'container-1', { APP_MODE: 'new' }, undefined, 'user-1')
    ).rejects.toMatchObject({ statusCode: 409, code: 'BUILD_ROLLOUT_IN_PROGRESS' });

    expect(environment.replace).not.toHaveBeenCalled();
    expect(stored.get('api')).toEqual({ APP_MODE: 'old' });
    expect(dispatch.sendDockerContainerCommand.mock.calls.map((call) => call[1])).not.toContain('update');
  });

  it('refuses a user recreate, restart and rename with the same 409', async () => {
    const { service } = createService(() => [rollout()]);
    const conflict = { statusCode: 409, code: 'BUILD_ROLLOUT_IN_PROGRESS' };
    await expect(
      service.recreateWithConfig('node-1', 'container-1', { image: 'team/api:2' }, 'user-1')
    ).rejects.toMatchObject(conflict);
    await expect(service.restartContainer('node-1', 'container-1', undefined, 'user-1')).rejects.toMatchObject(
      conflict
    );
    await expect(service.renameContainer('node-1', 'container-1', 'api-2', 'user-1')).rejects.toMatchObject(conflict);
  });

  it('builds the rollout recreate from the env saved before the rollout started', async () => {
    let rows: ActiveDockerBuildRollout[] = [];
    const { service, dispatch } = createService(() => rows);

    // (a) The user saves env after the build was queued, before its rollout.
    await service.updateContainerEnv('node-1', 'container-1', { APP_MODE: 'new' }, undefined, 'user-1');
    service.clearTransition('node-1', 'api'); // the update's watcher completed

    // The build is accepted and recreates the container with only its image.
    rows = [rollout()];
    const image = `127.0.0.1:5443/gateway/builds/api@sha256:${'a'.repeat(64)}`;
    await runAsDockerBuildRollout('build-1', () =>
      service.recreateWithConfig('node-1', 'container-1', { image }, null, { skipImagePull: true })
    );

    const config = dispatchedConfig(dispatch, 'recreate');
    expect(config.image).toBe(image);
    expect(config.env).toMatchObject({ APP_MODE: 'new' });
  });

  it('refuses a rollout recreate that would race a user update still in flight', async () => {
    const { service } = createService(() => [rollout()]);
    service.setTransition('node-1', 'api', 'updating');
    await expect(
      runAsDockerBuildRollout('build-1', () =>
        service.recreateWithConfig('node-1', 'container-1', { image: 'team/api:2' }, null, { skipImagePull: true })
      )
    ).rejects.toMatchObject({ code: 'CONTAINER_BUSY' });
  });
});
