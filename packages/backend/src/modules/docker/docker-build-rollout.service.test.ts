import { describe, expect, it, vi } from 'vitest';
import { DockerBuildRolloutService } from './docker-build-rollout.service.js';
import {
  COMPOSE_GIT_ROLLOUT_ACTION,
  composeGitRolloutIdempotencyKey,
  isComposeBuildBatchReady,
  isComposeRolloutCurrent,
} from './docker-compose-build-rollout.service.js';

describe('DockerBuildRolloutService', () => {
  it('pulls immutable Compose artifacts before applying a Git revision', () => {
    expect(COMPOSE_GIT_ROLLOUT_ACTION).toBe('pull_apply');
  });

  it('keeps duplicate events idempotent within a batch while allowing a same-commit retry batch', () => {
    expect(composeGitRolloutIdempotencyKey('source-1', 'batch-1')).toBe('git:source-1:batch-1');
    expect(composeGitRolloutIdempotencyKey('source-1', 'batch-1')).not.toBe(
      composeGitRolloutIdempotencyKey('source-1', 'batch-2')
    );
  });

  it('does not finalize an applying batch after a newer commit supersedes it', () => {
    expect(
      isComposeRolloutCurrent({ batchStatus: 'applying', desiredCommitSha: 'b'.repeat(40), commitSha: 'a'.repeat(40) })
    ).toBe(false);
    expect(
      isComposeRolloutCurrent({
        batchStatus: 'superseded',
        desiredCommitSha: 'a'.repeat(40),
        commitSha: 'a'.repeat(40),
      })
    ).toBe(false);
    expect(
      isComposeRolloutCurrent({ batchStatus: 'applying', desiredCommitSha: 'a'.repeat(40), commitSha: 'a'.repeat(40) })
    ).toBe(true);
  });

  it('waits for every Compose service artifact to pass policy before applying the project', () => {
    const expected = ['api', 'web'];
    expect(
      isComposeBuildBatchReady(expected, [
        { serviceName: 'api', status: 'ready', policyDecision: 'approved' },
        { serviceName: 'web', status: 'ready', policyDecision: 'pending' },
      ])
    ).toBe(false);
    expect(
      isComposeBuildBatchReady(expected, [
        { serviceName: 'api', status: 'ready', policyDecision: 'approved' },
        { serviceName: 'web', status: 'ready', policyDecision: 'approved' },
      ])
    ).toBe(true);
    expect(isComposeBuildBatchReady([], [])).toBe(false);
  });

  it('recreates an existing container from the immutable internal registry digest', async () => {
    const image = `127.0.0.1:5443/gateway/builds/source@sha256:${'a'.repeat(64)}`;
    const docker = {
      listContainers: vi.fn().mockResolvedValue([{ id: 'runtime-id', name: 'api' }]),
      inspectContainer: vi
        .fn()
        .mockResolvedValueOnce({
          Image: `sha256:${'c'.repeat(64)}`,
          Config: { Image: 'nginx:stable' },
          State: { Running: true },
        })
        .mockResolvedValue({ Config: { Image: image }, State: { Running: true } }),
      recreateWithConfig: vi.fn().mockResolvedValue({ accepted: true }),
    };
    const registry = { ensureBinding: vi.fn().mockResolvedValue({ id: 'binding' }) };
    const service = new DockerBuildRolloutService({} as never, docker as never, {} as never, registry as never);
    vi.spyOn(service as any, 'previousArtifactImage').mockResolvedValue(null);
    await (service as any).deployTarget(
      {
        targetKind: 'container',
        nodeId: '11111111-1111-4111-8111-111111111111',
        containerName: 'api',
      },
      image,
      null
    );

    expect(registry.ensureBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'runtime',
        repository: 'gateway/builds/source',
        actions: ['pull'],
        contextKind: 'container',
      })
    );
    expect(docker.recreateWithConfig).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'runtime-id',
      { image },
      null,
      { backgroundImagePull: false }
    );
  });

  it('does not confirm readiness while the old container revision still owns the name', async () => {
    vi.useFakeTimers();
    try {
      const image = `127.0.0.1:5443/gateway/builds/source@sha256:${'a'.repeat(64)}`;
      const docker = {
        listContainers: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'old-runtime-id', name: 'api' }])
          .mockResolvedValue([{ id: 'new-runtime-id', name: 'api' }]),
        inspectContainer: vi
          .fn()
          .mockResolvedValueOnce({ Config: { Image: 'nginx:stable' }, State: { Running: true } })
          .mockResolvedValue({ Config: { Image: image }, State: { Running: true } }),
      };
      const service = new DockerBuildRolloutService({} as never, docker as never, {} as never, {} as never);

      const readiness = (service as any).waitForContainerReady('node-1', 'api', image, 5_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(readiness).resolves.toBeUndefined();
      expect(docker.inspectContainer).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the previous image when the new container fails readiness', async () => {
    let recreateCount = 0;
    const newImage = `127.0.0.1:5443/gateway/builds/source@sha256:${'a'.repeat(64)}`;
    const previousImage = `127.0.0.1:5443/gateway/builds/source@sha256:${'b'.repeat(64)}`;
    const docker = {
      listContainers: vi.fn().mockResolvedValue([{ id: 'runtime-id', name: 'api' }]),
      inspectContainer: vi
        .fn()
        .mockResolvedValueOnce({ Config: { Image: 'nginx:stable' }, State: { Running: true } })
        .mockResolvedValueOnce({ Config: { Image: newImage }, State: { Running: false, Dead: true } })
        .mockResolvedValue({ Config: { Image: previousImage }, State: { Running: true } }),
      recreateWithConfig: vi.fn().mockImplementation(async () => {
        recreateCount += 1;
        return { accepted: true };
      }),
    };
    const registry = { ensureBinding: vi.fn().mockResolvedValue({ id: 'binding' }) };
    const service = new DockerBuildRolloutService({} as never, docker as never, {} as never, registry as never);
    vi.spyOn(service as any, 'previousArtifactImage').mockResolvedValue(previousImage);

    await expect(
      (service as any).deployTarget(
        { id: 'source-1', targetKind: 'container', nodeId: 'node-1', containerName: 'api' },
        newImage,
        null
      )
    ).rejects.toMatchObject({ code: 'BUILD_ROLLOUT_ROLLED_BACK' });
    expect(recreateCount).toBe(2);
    expect(docker.recreateWithConfig).toHaveBeenLastCalledWith('node-1', 'runtime-id', { image: previousImage }, null, {
      backgroundImagePull: false,
      skipImagePull: false,
    });
  });

  it('uses the existing blue-green deployment state machine for repository artifacts', async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [{ id: 'deployment-1', nodeId: 'node-1' }]) })),
        })),
      })),
    };
    const deployments = { deploy: vi.fn().mockResolvedValue({ id: 'deployment-1' }) };
    const registry = { ensureBinding: vi.fn().mockResolvedValue({ id: 'binding' }) };
    const service = new DockerBuildRolloutService(db as never, {} as never, deployments as never, registry as never);
    const image = `127.0.0.1:5443/gateway/builds/source@sha256:${'b'.repeat(64)}`;

    await (service as any).deployTarget({ targetKind: 'deployment', deploymentId: 'deployment-1' }, image, null);

    expect(registry.ensureBinding).toHaveBeenCalledWith(
      expect.objectContaining({ contextKind: 'deployment', contextId: 'deployment-1', actions: ['pull'] })
    );
    expect(deployments.deploy).toHaveBeenCalledWith('node-1', 'deployment-1', { image }, null, 'git_push_to_deploy');
  });

  it('activates a pending deployment with its first approved artifact', async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ id: 'deployment-1', nodeId: 'node-1', status: 'creating' }]),
          })),
        })),
      })),
    };
    const deployments = {
      activatePending: vi.fn().mockResolvedValue({ id: 'deployment-1' }),
      deploy: vi.fn(),
    };
    const registry = { ensureBinding: vi.fn().mockResolvedValue({ id: 'binding' }) };
    const service = new DockerBuildRolloutService(db as never, {} as never, deployments as never, registry as never);
    const image = `127.0.0.1:5443/gateway/builds/source@sha256:${'c'.repeat(64)}`;

    await (service as any).deployTarget({ targetKind: 'deployment', deploymentId: 'deployment-1' }, image, 'user-1');

    expect(deployments.activatePending).toHaveBeenCalledWith('node-1', 'deployment-1', image, 'user-1');
    expect(deployments.deploy).not.toHaveBeenCalled();
  });

  it('creates a missing source container from the stored initial configuration', async () => {
    const docker = {
      listContainers: vi.fn().mockResolvedValue([]),
      pullImageImmediate: vi.fn().mockResolvedValue({ status: 'pulled' }),
      createContainer: vi.fn().mockResolvedValue({ id: 'runtime-id' }),
      startContainer: vi.fn().mockResolvedValue(undefined),
      removeContainer: vi.fn().mockResolvedValue(undefined),
      recreateWithConfig: vi.fn(),
    };
    const registry = { ensureBinding: vi.fn().mockResolvedValue({ id: 'binding' }) };
    const service = new DockerBuildRolloutService({} as never, docker as never, {} as never, registry as never);
    const waitForContainerReady = vi.spyOn(service as any, 'waitForContainerReady').mockResolvedValue(undefined);
    const image = `127.0.0.1:5443/gateway/builds/source@sha256:${'d'.repeat(64)}`;

    await (service as any).deployTarget(
      {
        targetKind: 'container',
        nodeId: '11111111-1111-4111-8111-111111111111',
        containerName: 'api',
        initialConfig: { restartPolicy: 'unless-stopped', runtimeProfile: 'secure' },
      },
      image,
      'user-1'
    );

    expect(docker.createContainer).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      { restartPolicy: 'unless-stopped', runtimeProfile: 'secure', name: 'api', image },
      'user-1',
      []
    );
    expect(docker.pullImageImmediate).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', image);
    expect(docker.pullImageImmediate.mock.invocationCallOrder[0]).toBeLessThan(
      docker.createContainer.mock.invocationCallOrder[0]!
    );
    expect(docker.startContainer).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'runtime-id', 'user-1');
    expect(waitForContainerReady).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'api', image, 60_000);
    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(docker.recreateWithConfig).not.toHaveBeenCalled();
  });

  it('removes a newly created source container when its first start fails', async () => {
    const docker = {
      listContainers: vi.fn().mockResolvedValue([]),
      pullImageImmediate: vi.fn().mockResolvedValue({ status: 'pulled' }),
      createContainer: vi.fn().mockResolvedValue({ id: 'runtime-id' }),
      startContainer: vi.fn().mockRejectedValue(new Error('start failed')),
      removeContainer: vi.fn().mockResolvedValue(undefined),
    };
    const registry = { ensureBinding: vi.fn().mockResolvedValue({ id: 'binding' }) };
    const service = new DockerBuildRolloutService({} as never, docker as never, {} as never, registry as never);

    await expect(
      (service as any).deployTarget(
        {
          targetKind: 'container',
          nodeId: '11111111-1111-4111-8111-111111111111',
          containerName: 'api',
          initialConfig: { restartPolicy: 'unless-stopped' },
        },
        `127.0.0.1:5443/gateway/builds/source@sha256:${'e'.repeat(64)}`,
        'user-1'
      )
    ).rejects.toThrow('start failed');
    expect(docker.removeContainer).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'runtime-id',
      true,
      'user-1'
    );
  });

  it('does not deploy a completed artifact after a newer desired commit supersedes it', async () => {
    const joined = {
      build: { id: 'build-1', commitSha: 'a'.repeat(40), createdById: null },
      source: { id: 'source-1', desiredCommitSha: 'b'.repeat(40) },
      artifact: { policyDecision: 'approved', status: 'ready' },
    };
    const tx = {
      execute: vi.fn(),
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn(async () => [{ sourceBindingId: 'source-1' }]) })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [joined]) })) })),
            })),
          })),
        }),
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn(async () => [{ targetKind: 'container' }]) })),
          })),
        })),
      })),
      transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const service = new DockerBuildRolloutService(db as never, {} as never, {} as never, {} as never);
    const deployTarget = vi.spyOn(service as any, 'deployTarget');

    await expect(service.rollout('build-1')).resolves.toBe('superseded');
    expect(tx.execute).toHaveBeenCalledOnce();
    expect(deployTarget).not.toHaveBeenCalled();
  });

  it('serializes duplicate rollout events and deploys an immutable commit only once', async () => {
    const commitSha = 'a'.repeat(40);
    const joined = {
      build: { id: 'build-1', commitSha, createdById: null },
      source: {
        id: 'source-1',
        desiredCommitSha: commitSha,
        deployedCommitSha: null as string | null,
        createdById: 'source-owner-1',
      },
      artifact: {
        id: 'artifact-1',
        registryRepository: 'gateway/builds/source-1',
        digest: `sha256:${'b'.repeat(64)}`,
        policyDecision: 'approved',
        status: 'ready',
      },
    };
    let transactionTail = Promise.resolve();
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn(async () => [{ targetKind: 'container' }]) })),
          })),
        })),
      })),
      transaction: vi.fn((callback: (tx: any) => Promise<unknown>) => {
        const current = transactionTail.then(async () => {
          const tx = {
            execute: vi.fn(),
            select: vi
              .fn()
              .mockReturnValueOnce({
                from: vi.fn(() => ({
                  where: vi.fn(() => ({ limit: vi.fn(async () => [{ sourceBindingId: 'source-1' }]) })),
                })),
              })
              .mockReturnValueOnce({
                from: vi.fn(() => ({
                  innerJoin: vi.fn(() => ({
                    innerJoin: vi.fn(() => ({
                      where: vi.fn(() => ({ limit: vi.fn(async () => [{ ...joined, source: { ...joined.source } }]) })),
                    })),
                  })),
                })),
              }),
            update: vi.fn(() => ({
              set: vi.fn((values: { deployedCommitSha?: string }) => ({
                where: vi.fn(async () => {
                  if (values.deployedCommitSha) joined.source.deployedCommitSha = values.deployedCommitSha;
                  return [];
                }),
              })),
            })),
          };
          return callback(tx);
        });
        transactionTail = current.then(
          () => undefined,
          () => undefined
        );
        return current;
      }),
    };
    const service = new DockerBuildRolloutService(db as never, {} as never, {} as never, {} as never);
    const deployTarget = vi.spyOn(service as any, 'deployTarget').mockResolvedValue('container:node-1:api');
    vi.spyOn(service as any, 'rotatePins').mockResolvedValue(undefined);

    await expect(Promise.all([service.rollout('build-1'), service.rollout('build-1')])).resolves.toEqual([
      'deployed',
      'deployed',
    ]);
    expect(deployTarget).toHaveBeenCalledOnce();
    expect(deployTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'source-1' }),
      `127.0.0.1:5443/gateway/builds/source-1@sha256:${'b'.repeat(64)}`,
      'source-owner-1'
    );
  });
});
