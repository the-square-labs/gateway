import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  dockerBuildArtifacts,
  dockerDeploymentReleases,
  dockerDeploymentSlots,
  dockerDeployments,
} from '@/db/schema/index.js';
import { DockerAvailabilityService } from './docker-availability.service.js';

function fixture() {
  const subject = new DockerAvailabilityService(
    {} as never,
    {} as never,
    { requireFeature: vi.fn() } as never,
    {} as never,
    { publish: vi.fn() } as never
  ) as any;
  const policy = {
    id: 'policy',
    mode: 'replicated',
    resourceKind: 'deployment',
    shouldRun: true,
    desiredGeneration: 7,
    sourceNodeId: 'origin',
    containerName: 'api',
    imageReference: 'internal-mirror',
    portableSpec: {
      activeSlot: 'blue',
      image: 'registry/api:v1',
      sourceImageReference: 'registry/api:canonical',
      runtimeProfile: 'secure',
      desiredConfig: { image: 'registry/api:v1', runtimeProfile: 'secure', env: { KEEP: 'yes' } },
    },
    specFingerprint: '',
  };
  subject.findPolicyByResourceReference = vi.fn().mockResolvedValue(policy);
  subject.requirePolicy = vi.fn().mockResolvedValue(policy);
  subject.findActiveContainerPolicy = vi.fn().mockResolvedValue(policy);
  subject.queueCanonicalRollout = vi.fn().mockResolvedValue('operation');
  subject.waitForOperationCompletion = vi.fn();
  subject.db = { update: () => ({ set: () => ({ where: vi.fn() }) }) };
  return { subject, policy };
}

describe('canonical HA deployment and deferred configuration', () => {
  describe('canonical Git container build image getter', () => {
    const repository = 'gateway/builds/source/web';
    const digest = `sha256:${'a'.repeat(64)}`;
    const image = `127.0.0.1:5443/${repository}@${digest}`;
    const mirror = `127.0.0.1:5443/gateway/availability/policy/1/44@${digest}`;

    function buildFixture(artifact: { repository: string; digest: string; status: string } | null) {
      const { subject, policy } = fixture();
      policy.portableSpec.sourceImageReference = image;
      policy.portableSpec.image = mirror;
      policy.imageReference = mirror;
      const queryValues = (condition: any): unknown[] =>
        (condition?.queryChunks ?? []).flatMap((chunk: any) =>
          chunk?.queryChunks ? queryValues(chunk) : chunk?.value !== undefined ? [chunk.value] : []
        );
      const select = vi.fn(() => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => ({
            limit: async () => {
              const values = queryValues(condition);
              return table === dockerBuildArtifacts &&
                artifact?.status === 'ready' &&
                values.includes(artifact.repository) &&
                values.includes(artifact.digest) &&
                values.includes('ready')
                ? [{ id: 'artifact' }]
                : [];
            },
          }),
        }),
      }));
      subject.db.select = select;
      return { subject, policy, select };
    }

    it.each([
      'sourceImageReference',
      'image',
    ])('returns a verified build digest from portableSpec.%s without secrets', async (field) => {
      const { subject, policy } = buildFixture({ repository, digest, status: 'ready' });
      policy.portableSpec.sourceImageReference = field === 'sourceImageReference' ? image : mirror;
      policy.portableSpec.image = field === 'image' ? image : mirror;
      policy.shouldRun = false;
      expect(await subject.getContainerConfiguration('replica', 'runtime-name')).toEqual({
        image,
        runtimeProfile: 'secure',
        shouldRun: false,
        nodeId: 'origin',
        containerName: 'api',
      });
    });

    it.each([
      null,
      { repository, digest, status: 'deleted' },
      { repository: 'gateway/builds/other', digest, status: 'ready' },
      { repository, digest: `sha256:${'b'.repeat(64)}`, status: 'ready' },
    ])('does not expose a build reference without exact ready metadata %#', async (artifact) => {
      const { subject } = buildFixture(artifact);
      expect(await subject.getContainerConfiguration('origin', 'api')).toMatchObject({ image: '' });
    });

    it.each([
      mirror,
      `127.0.0.1:5443/${repository}:latest`,
    ])('does not trust a mirror or mutable internal tag (%s)', async (candidate) => {
      const { subject, policy, select } = buildFixture({ repository, digest, status: 'ready' });
      policy.portableSpec.sourceImageReference = candidate;
      policy.portableSpec.image = candidate;
      expect(await subject.getContainerConfiguration('origin', 'api')).toMatchObject({ image: '' });
      expect(select).not.toHaveBeenCalled();
    });

    it('preserves existing public-image selection without querying internal artifacts', async () => {
      const { subject, policy, select } = buildFixture({ repository, digest, status: 'ready' });
      policy.portableSpec.sourceImageReference = 'registry.example/api:canonical';
      expect(await subject.getContainerConfiguration('origin', 'api')).toMatchObject({
        image: 'registry.example/api:canonical',
      });
      expect(select).not.toHaveBeenCalled();
    });
  });

  it('returns only canonical container configuration, never environment or mirror metadata', async () => {
    const { subject } = fixture();
    expect(await subject.getContainerConfiguration('replica', 'api')).toEqual({
      image: 'registry/api:canonical',
      runtimeProfile: 'secure',
      shouldRun: true,
      nodeId: 'origin',
      containerName: 'api',
    });
    subject.findActiveContainerPolicy.mockResolvedValue(null);
    expect(await subject.getContainerConfiguration('node', 'unmanaged')).toBeNull();
  });

  it.each([
    true,
    false,
  ])('updates canonical deployment tag/env and awaits the rollout while preserving shouldRun=%s', async (shouldRun) => {
    const { subject, policy } = fixture();
    policy.shouldRun = shouldRun;
    const result = await subject.deployDeployment(
      'deployment',
      { tag: 'v2', env: { NEXT: 'yes' } },
      'green',
      'user',
      'webhook'
    );
    expect(result).toMatchObject({
      shouldRun,
      desiredConfig: { image: 'registry/api:v2', runtimeProfile: 'secure', env: { NEXT: 'yes' } },
    });
    expect(subject.queueCanonicalRollout).toHaveBeenCalledWith(
      'policy',
      expect.objectContaining({
        shouldRun,
        portableSpec: expect.objectContaining({ desiredConfig: expect.objectContaining({ runtimeProfile: 'secure' }) }),
      }),
      'user',
      'webhook',
      expect.objectContaining({ deploymentDeploy: true })
    );
    expect(subject.waitForOperationCompletion).toHaveBeenCalledWith('operation');
  });

  it('restores the complete HA rollback configuration instead of mixing it with the current release', async () => {
    const { subject } = fixture();
    const previous = {
      image: 'registry/api:previous',
      env: { OLD: 'yes' },
      command: ['old'],
      runtimeProfile: 'secure',
    };
    const result = await subject.deployDeployment(
      'deployment',
      { image: previous.image, desiredConfig: previous },
      'green',
      'user',
      'rollback'
    );
    expect(result.desiredConfig).toEqual(previous);
    expect(subject.waitForOperationCompletion).toHaveBeenCalledWith('operation');
  });

  it('forces a same-spec container rollout and awaits failure propagation', async () => {
    const { subject, policy } = fixture();
    policy.imageReference = 'registry/api:v1';
    policy.specFingerprint = createHash('sha256').update(JSON.stringify(policy.portableSpec)).digest('hex');
    await subject.updateContainerConfiguration('node', 'api', {}, 'user');
    expect(subject.queueCanonicalRollout).not.toHaveBeenCalled();
    subject.waitForOperationCompletion.mockRejectedValue(new Error('rollout failed'));
    await expect(
      subject.updateContainerConfiguration('node', 'api', {}, 'user', { forceRollout: true, waitForCompletion: true })
    ).rejects.toThrow('rollout failed');
    expect(subject.queueCanonicalRollout).toHaveBeenCalledOnce();
  });

  it('never queues HA operations for an unmanaged container or a single deployment', async () => {
    const { subject, policy } = fixture();
    subject.findActiveContainerPolicy.mockResolvedValue(null);
    expect(
      await subject.updateContainerConfiguration('node', 'plain', {}, 'user', {
        forceRollout: true,
        waitForCompletion: true,
      })
    ).toBe(false);
    policy.mode = 'single';
    await expect(subject.deployDeployment('deployment', {}, 'green', 'user', 'git')).rejects.toMatchObject({
      code: 'AVAILABILITY_NOT_ENABLED',
    });
    expect(subject.queueCanonicalRollout).not.toHaveBeenCalled();
  });

  it('turns Start after deferred stopped config into rollout, but leaves unchanged Start as lifecycle', async () => {
    const { subject, policy } = fixture();
    const latest = {
      targetGeneration: 7,
      status: 'completed',
      requestedPolicy: { deferredUntilStart: true, deploymentDeploy: true },
    };
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [latest] }) }) }) }),
      update: () => ({ set: () => ({ where: vi.fn() }) }),
    };
    subject.db.transaction = (run: any) => run(tx);
    subject.lockPolicy = vi.fn();
    subject.requirePolicy = vi.fn().mockResolvedValue(policy);
    subject.supersedeQueuedOperations = vi.fn();
    subject.kick = vi.fn();
    subject.insertOperation = vi.fn(async (_tx, input) => ({ id: 'operation', ...input }));
    await subject.queueLifecycle('policy', 'start', null);
    expect(subject.insertOperation).toHaveBeenLastCalledWith(
      tx,
      expect.objectContaining({
        type: 'rollout',
        targetGeneration: 8,
        requestedPolicy: expect.objectContaining({ deferredUntilStart: false, targetActiveSlot: 'green' }),
      })
    );
    latest.requestedPolicy.deferredUntilStart = false;
    await subject.queueLifecycle('policy', 'start', null);
    expect(subject.insertOperation).toHaveBeenLastCalledWith(
      tx,
      expect.objectContaining({ type: 'start', targetGeneration: 7 })
    );
  });

  describe.each(['start', 'restart'])('%s rollout recovery generation fence', (type) => {
    it.each([
      { generation: 43, status: 'cancelled', deferred: false, expected: 'lifecycle' },
      { generation: 43, status: 'completed', deferred: true, expected: 'lifecycle' },
      { generation: 43, status: 'failed', deferred: true, expected: 'lifecycle' },
      { generation: 44, status: 'completed', deferred: false, expected: 'lifecycle' },
      { generation: 44, status: 'completed', deferred: true, expected: 'rollout' },
      { generation: 44, status: 'failed', deferred: false, expected: 'rollout' },
      { generation: 44, status: 'cancelled', deferred: false, expected: 'rollout' },
      { generation: 44, status: 'waiting', deferred: false, expected: 'rollout' },
      { generation: 45, status: 'failed', deferred: false, expected: 'lifecycle' },
    ])('gen $generation $status deferred=$deferred -> $expected', async ({
      generation,
      status,
      deferred,
      expected,
    }) => {
      const { subject, policy } = fixture();
      policy.desiredGeneration = 44;
      policy.shouldRun = false;
      const latest = { targetGeneration: generation, status, requestedPolicy: { deferredUntilStart: deferred } };
      const patches: Array<Record<string, unknown>> = [];
      const tx = {
        select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [latest] }) }) }) }),
        update: () => ({
          set: (patch: Record<string, unknown>) => ({
            where: async () => {
              patches.push(patch);
            },
          }),
        }),
      };
      subject.db.transaction = (run: any) => run(tx);
      subject.lockPolicy = vi.fn();
      subject.supersedeQueuedOperations = vi.fn();
      subject.kick = vi.fn();
      subject.insertOperation = vi.fn(async (_tx, input) => ({ id: 'operation', ...input }));
      await subject.queueLifecycle('policy', type, null);
      const input = subject.insertOperation.mock.calls[0][1];
      expect(input).toMatchObject({
        type: expected === 'rollout' ? 'rollout' : type,
        targetGeneration: expected === 'rollout' ? 45 : 44,
      });
      if (expected === 'lifecycle') {
        expect(input).not.toHaveProperty('requestedPolicy');
        for (const patch of patches) {
          expect(patch).not.toHaveProperty('desiredGeneration');
          expect(patch).not.toHaveProperty('portableSpec');
          expect(patch).not.toHaveProperty('specFingerprint');
        }
      } else {
        expect(input.requestedPolicy).toMatchObject({ deferredUntilStart: false, targetActiveSlot: 'green' });
      }
    });
  });

  it.each([
    'deployment',
    'container',
  ])('uses an online artifact source for %s without changing runtime ownership', async (kind) => {
    const { subject, policy } = fixture();
    policy.resourceKind = kind;
    const resource = { kind, currentNodeId: 'origin', running: true, portableSpec: policy.portableSpec };
    subject.requirePolicy = vi.fn().mockResolvedValue(policy);
    subject.resolvePolicyResource = vi.fn().mockResolvedValue(resource);
    subject.requireAdapter = vi.fn().mockReturnValue({});
    subject.updateOperationPhase = vi.fn();
    subject.policyInput = vi.fn();
    subject.resolveCandidateNodes = vi.fn().mockResolvedValue([{ id: 'replica', compatible: true }]);
    subject.nodeRegistry = { getNode: (id: string) => (id === 'replica' ? {} : undefined) };
    subject.artifacts = {
      prepare: vi.fn(async (input) => ({ ...input.resource, imageReference: 'shared@sha256:digest' })),
    };
    subject.executeRollout = vi.fn();
    await subject.executeReconcile({
      id: 'operation',
      policyId: 'policy',
      type: 'rollout',
      targetGeneration: 8,
      requestedPolicy: kind === 'deployment' ? { deploymentDeploy: true } : { source: 'configuration' },
    });
    expect(subject.artifacts.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ resource: expect.objectContaining({ currentNodeId: 'replica' }) })
    );
    expect(subject.executeRollout).toHaveBeenCalledWith(
      expect.anything(),
      policy,
      expect.objectContaining({ currentNodeId: 'origin', imageReference: 'shared@sha256:digest' }),
      expect.anything(),
      expect.anything(),
      false
    );
    expect(resource.currentNodeId).toBe('origin');
  });

  it.each([
    undefined,
    'release',
  ])('syncs deferred deployment Start metadata independently of release id (%s)', async (releaseId) => {
    const { subject, policy } = fixture();
    Object.assign(policy, { deploymentId: 'deployment' });
    const operation = {
      id: 'operation',
      policyId: 'policy',
      type: 'rollout',
      targetGeneration: 8,
      requestedPolicy: {
        deferredUntilStart: false,
        source: 'start_deferred_configuration',
        targetActiveSlot: 'green',
        ...(releaseId ? { deploymentReleaseId: releaseId } : {}),
      },
    };
    const updates: Array<{ table: unknown; patch: any }> = [];
    subject.db = {
      transaction: vi.fn().mockResolvedValue(operation),
      update: (table: unknown) => ({
        set: (patch: any) => ({
          where: async () => {
            updates.push({ table, patch });
          },
        }),
      }),
    };
    subject.licensePolicy = { hasFeature: vi.fn().mockResolvedValue(true) };
    subject.executeReconcile = vi.fn();
    await subject.processOperation('operation');
    expect(updates).toContainEqual({
      table: dockerDeployments,
      patch: expect.objectContaining({ activeSlot: 'green' }),
    });
    expect(updates).toContainEqual({ table: dockerDeployments, patch: expect.objectContaining({ status: 'ready' }) });
    expect(updates).toContainEqual({
      table: dockerDeploymentSlots,
      patch: expect.objectContaining({ status: 'running', health: 'healthy' }),
    });
    const releaseUpdates = updates.filter((update) => update.table === dockerDeploymentReleases);
    expect(releaseUpdates).toHaveLength(releaseId ? 1 : 0);
    if (releaseId) expect(releaseUpdates[0]?.patch).toMatchObject({ status: 'succeeded' });
  });
});
