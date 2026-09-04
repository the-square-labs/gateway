import { describe, expect, it, vi } from 'vitest';
import { dockerBuildBatches, dockerSourceBindings } from '@/db/schema/index.js';
import { DockerBuildRolloutService } from './docker-build-rollout.service.js';
import { DockerComposeBuildRolloutService } from './docker-compose-build-rollout.service.js';

function query(rows: () => unknown[]) {
  const result = Promise.resolve().then(rows);
  const builder: any = Object.assign(result, {
    from: vi.fn(() => builder),
    innerJoin: vi.fn(() => builder),
    leftJoin: vi.fn(() => builder),
    where: vi.fn(() => builder),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(() => result),
  });
  return builder;
}

const commit = 'a'.repeat(40);
const leaseOwner = 'rollout-owner';
const operationId = 'rollout-operation';

function artifactHarness(kind: 'container' | 'deployment', activeArtifactId: string | null) {
  const ownerKey = kind === 'deployment' ? 'deployment:deployment-1' : 'container:node-1:api';
  const current = {
    build: {
      id: 'build-new',
      commitSha: commit,
      status: 'deploying',
      leaseOwner,
      createdById: 'actor',
      progress: { rollout: { operationId, attempt: 1, phase: 'executing' } },
    },
    source: {
      id: 'source-1',
      targetKind: kind,
      nodeId: 'node-1',
      containerName: 'api',
      deploymentId: 'deployment-1',
      desiredCommitSha: commit,
      deployedCommitSha: commit as string | null,
    },
    artifact: {
      id: 'artifact-new',
      registryRepository: 'gateway/builds/new',
      digest: `sha256:${'b'.repeat(64)}`,
      status: 'ready',
      policyDecision: 'approved',
    },
  };
  const pins: { active: string | null; rollback: string | null } = { active: activeArtifactId, rollback: null };
  const execute = vi.fn();
  const insert = vi.fn(() => ({
    values: vi.fn(async (pin: { kind: 'active' | 'rollback'; artifactId: string }) => {
      pins[pin.kind] = pin.artifactId;
    }),
  }));
  let deleteIndex = 0;
  const remove = vi.fn(() => ({
    where: vi.fn(async () => {
      pins[deleteIndex++ % 2 === 0 ? 'rollback' : 'active'] = null;
    }),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((values) => ({
      where: vi.fn(async () => {
        Object.assign(current.source, values);
      }),
    })),
  }));
  const db = {
    select: vi.fn(() => query(() => [{ targetKind: kind, ...current.build }])),
    transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      let selection = 0;
      const tx = {
        execute,
        insert,
        delete: remove,
        update,
        select: vi.fn(() => {
          const index = selection++;
          return query(() =>
            index === 0
              ? [{ sourceBindingId: current.source.id }]
              : index === 1
                ? [current]
                : index === 2
                  ? pins.active === current.artifact.id
                    ? [{ artifactId: pins.active }]
                    : []
                  : pins.active
                    ? [{ artifactId: pins.active }]
                    : []
          );
        }),
      };
      return work(tx);
    }),
  };
  const service = new DockerBuildRolloutService(db as never, {} as never, {} as never, {} as never);
  const deploy = vi.spyOn(service as any, 'deployTarget').mockResolvedValue(ownerKey);
  return { service, current, pins, deploy, insert, remove, update, execute };
}

describe('Artifact-aware container/deployment rollout idempotency', () => {
  it.each([
    'container',
    'deployment',
  ] as const)('deploys a new %s artifact at an already deployed commit, rotates pins, then deduplicates replay', async (kind) => {
    const { service, current, pins, deploy, execute } = artifactHarness(kind, 'artifact-old');
    await expect(service.rollout('build-new', leaseOwner, operationId)).resolves.toBe('deployed');
    expect(deploy).toHaveBeenCalledExactlyOnceWith(
      current.source,
      `127.0.0.1:5443/gateway/builds/new@sha256:${'b'.repeat(64)}`,
      'actor'
    );
    expect(pins).toEqual({ active: 'artifact-new', rollback: 'artifact-old' });
    expect(execute).toHaveBeenCalledOnce();

    await expect(service.rollout('build-new', leaseOwner, operationId)).resolves.toBe('deployed');
    expect(deploy).toHaveBeenCalledOnce();
    expect(pins).toEqual({ active: 'artifact-new', rollback: 'artifact-old' });
  });

  it.each([
    'container',
    'deployment',
  ] as const)('does not redeploy or rotate pins for the already active %s artifact', async (kind) => {
    const { service, deploy, insert, remove, update } = artifactHarness(kind, 'artifact-new');
    await expect(service.rollout('build-new', leaseOwner, operationId)).resolves.toBe('deployed');
    expect(deploy).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('does not trust a deployed commit when its active artifact pin is absent', async () => {
    const { service, deploy, pins } = artifactHarness('container', null);
    await expect(service.rollout('build-new', leaseOwner, operationId)).resolves.toBe('deployed');
    expect(deploy).toHaveBeenCalledOnce();
    expect(pins.active).toBe('artifact-new');
  });

  it.each([
    'container',
    'deployment',
  ] as const)('honors the cleared deployed SHA after HA %s rollback despite a matching active pin', async (kind) => {
    const { service, current, deploy } = artifactHarness(kind, 'artifact-new');
    current.source.deployedCommitSha = null;
    await expect(service.rollout('build-new', leaseOwner, operationId)).resolves.toBe('deployed');
    expect(deploy).toHaveBeenCalledOnce();
    expect(current.source.deployedCommitSha).toBe(commit);
  });

  it('still supersedes artifacts from a no-longer-desired commit', async () => {
    const { service, current, deploy, insert } = artifactHarness('container', 'artifact-new');
    current.source.desiredCommitSha = 'c'.repeat(40);
    await expect(service.rollout('build-new', leaseOwner, operationId)).resolves.toBe('superseded');
    expect(deploy).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});

function composeHarness() {
  const artifact = {
    id: 'artifact-new',
    registryRepository: 'gateway/builds/new',
    digest: `sha256:${'b'.repeat(64)}`,
    status: 'ready',
    policyDecision: 'approved',
  };
  const current = {
    build: { id: 'build-new', commitSha: commit, createdById: 'actor', serviceName: 'api' },
    batch: {
      id: 'batch-new',
      status: 'building',
      candidateRevisionId: null as string | null,
      composeVariables: {},
      composeSecretKeys: [],
      composeBuildPlan: { sourceYaml: 'services:\n  api:\n    build: .\n', services: [{ serviceName: 'api' }] },
    },
    source: { id: 'source-1', desiredCommitSha: commit, deployedCommitSha: commit, autoDeploy: true },
    project: { id: 'project-1', nodeId: 'node-1', name: 'app', activeRevisionId: 'revision-old' },
  };
  const execute = vi.fn();
  const update = vi.fn((table) => ({
    set: vi.fn((values) => {
      const apply = () => {
        if (
          table === dockerBuildBatches &&
          values.status === 'applying' &&
          !['building', 'awaiting_approval'].includes(current.batch.status)
        )
          return [];
        if (table === dockerBuildBatches) Object.assign(current.batch, values);
        if (table === dockerSourceBindings) Object.assign(current.source, values);
        return [{ id: current.batch.id }];
      };
      return {
        where: vi.fn(() => {
          const result = Promise.resolve().then(apply);
          return Object.assign(result, { returning: vi.fn(() => result) });
        }),
      };
    }),
  }));
  const db = {
    transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      let selection = 0;
      return work({
        execute,
        update,
        select: vi.fn(() => {
          const index = selection++;
          return query(() => (index === 0 ? [current] : [{ build: current.build, artifact }]));
        }),
      });
    }),
  };
  const registry = { ensureBinding: vi.fn().mockResolvedValue({}) };
  const compose = {
    createGitRevision: vi.fn().mockResolvedValue({ id: 'revision-new' }),
    startOperation: vi.fn().mockResolvedValue({ id: 'apply-new' }),
    waitForOperation: vi.fn().mockResolvedValue(undefined),
  };
  const service = new DockerComposeBuildRolloutService(db as never, registry as never, compose as never);
  const pinRevision = vi.spyOn(service as any, 'pinRevisionArtifacts').mockImplementation(async () => {
    current.batch.candidateRevisionId = 'revision-new';
  });
  const finalize = vi.spyOn(service as any, 'finalizeApplied').mockImplementation(async () => {
    current.batch.status = 'succeeded';
    current.project.activeRevisionId = 'revision-new';
    return 'deployed';
  });
  const markFailed = vi.spyOn(service as any, 'markFailed').mockResolvedValue(true);
  return { service, current, artifact, compose, pinRevision, finalize, markFailed, execute };
}

describe('Batch-aware Compose rollout idempotency', () => {
  it('applies a new batch/new artifact at the same commit and does not apply a completed-batch replay', async () => {
    const { service, current, compose, pinRevision, finalize } = composeHarness();
    await expect(service.rollout('build-new')).resolves.toBe('deployed');
    expect(compose.createGitRevision).toHaveBeenCalledWith(
      'node-1',
      'project-1',
      expect.objectContaining({
        yaml: expect.stringContaining(`127.0.0.1:5443/gateway/builds/new@sha256:${'b'.repeat(64)}`),
      }),
      expect.objectContaining({ batchId: 'batch-new', commitSha: commit }),
      'actor'
    );
    expect(compose.startOperation).toHaveBeenCalledExactlyOnceWith(
      'node-1',
      'project-1',
      'pull_apply',
      {
        revisionId: 'revision-new',
        idempotencyKey: 'git:source-1:batch-new',
        removeOrphans: true,
        volumeNames: [],
      },
      'actor'
    );
    expect(compose.waitForOperation).toHaveBeenCalledWith('apply-new');
    expect(pinRevision).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
    expect(current.project.activeRevisionId).toBe('revision-new');

    await expect(service.rollout('build-new')).resolves.toBe('deployed');
    expect(compose.createGitRevision).toHaveBeenCalledOnce();
    expect(compose.startOperation).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
  });

  it('does not call an unapplied successful build batch deployed or apply it implicitly', async () => {
    const { service, current, compose } = composeHarness();
    current.batch.status = 'succeeded';
    current.batch.candidateRevisionId = 'revision-new';
    current.source.autoDeploy = false;
    await expect(service.rollout('build-new')).resolves.toBe('pending');
    expect(compose.startOperation).not.toHaveBeenCalled();
  });

  it('does not let same-commit history bypass policy approval for a new batch', async () => {
    const { service, artifact, current, compose } = composeHarness();
    artifact.policyDecision = 'rejected';
    await expect(service.rollout('build-new')).resolves.toBe('pending');
    expect(current.batch.status).toBe('awaiting_approval');
    expect(compose.createGitRevision).not.toHaveBeenCalled();
  });

  it('does not apply or finalize a second event while the batch is applying', async () => {
    const { service, current, compose, finalize } = composeHarness();
    current.batch.status = 'applying';
    await expect(service.rollout('build-new')).resolves.toBe('pending');
    expect(current.batch.status).toBe('applying');
    expect(compose.startOperation).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it('still supersedes a completed batch after the desired commit changes', async () => {
    const { service, current, compose } = composeHarness();
    current.batch.status = 'succeeded';
    current.batch.candidateRevisionId = current.project.activeRevisionId;
    current.source.desiredCommitSha = 'c'.repeat(40);
    await expect(service.rollout('build-new')).resolves.toBe('superseded');
    expect(compose.startOperation).not.toHaveBeenCalled();
  });
});
