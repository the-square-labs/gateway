import { describe, expect, it, vi } from 'vitest';
import {
  dockerAvailabilityOperations,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  dockerComposeProjects,
  dockerDeploymentSlots,
  dockerDeployments,
} from '@/db/schema/index.js';
import {
  DockerComposeAvailabilityAdapter,
  DockerContainerAvailabilityAdapter,
  DockerDeploymentAvailabilityAdapter,
} from './docker-availability.adapters.js';
import { DockerAvailabilityService } from './docker-availability.service.js';

function service() {
  return new DockerAvailabilityService(
    {} as never,
    {} as never,
    {} as never,
    { log: vi.fn() } as never,
    { publish: vi.fn() } as never
  ) as any;
}

describe('HA lifecycle dispatch', () => {
  it.each([
    'start',
    'stop',
    'restart',
  ])('processes %s independently of reconciliation and artifact delivery', async (type) => {
    const subject = service();
    const operation = { id: 'operation', policyId: 'policy', type, targetGeneration: 7 };
    subject.db = {
      transaction: vi.fn().mockResolvedValue(operation),
      update: () => ({ set: () => ({ where: vi.fn() }) }),
    };
    subject.licensePolicy = { hasFeature: vi.fn().mockResolvedValue(true) };
    subject.executeLifecycle = vi.fn();
    subject.executeReconcile = vi.fn();
    subject.artifacts = { prepare: vi.fn(), releaseObsoletePins: vi.fn() };
    await subject.processOperation('operation');
    expect(subject.executeLifecycle).toHaveBeenCalledWith(operation);
    expect(subject.executeReconcile).not.toHaveBeenCalled();
    expect(subject.artifacts.prepare).not.toHaveBeenCalled();
    expect(subject.artifacts.releaseObsoletePins).not.toHaveBeenCalled();
  });

  it.each([
    'container',
    'deployment',
    'compose',
  ])('%s start/stop/restart queue explicit operations, never rollouts', async (kind) => {
    const subject = service();
    const policy = { id: 'policy', mode: 'replicated', shouldRun: true };
    subject.findActiveContainerPolicy = vi.fn().mockResolvedValue(policy);
    subject.findPolicyByResourceReference = vi.fn().mockResolvedValue(policy);
    subject.licensePolicy = { requireFeature: vi.fn() };
    subject.queueLifecycle = vi.fn();
    subject.queueCanonicalRollout = vi.fn();
    for (const [running, restart, type] of [
      [false, false, 'stop'],
      [true, false, 'start'],
      [true, true, 'restart'],
    ] as const) {
      if (kind === 'container') await subject.setContainerRunning('node', 'app', running, 'user', restart);
      if (kind === 'deployment') await subject.setDeploymentRunning('deployment', running, 'user', restart);
      if (kind === 'compose') await subject.setComposeRunning('project', running, 'user', restart);
      expect(subject.queueLifecycle).toHaveBeenLastCalledWith('policy', type, 'user');
    }
    expect(subject.queueCanonicalRollout).not.toHaveBeenCalled();
  });

  it('keeps the spec generation and gives repeated lifecycle commands distinct idempotency keys', async () => {
    const subject = service();
    const policy = { id: 'policy', mode: 'replicated', desiredGeneration: 7 };
    const set = vi.fn((_patch: unknown) => ({ where: vi.fn() }));
    const tx = {
      update: vi.fn(() => ({ set })),
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }),
    };
    subject.db = { transaction: (run: any) => run(tx) };
    subject.lockPolicy = vi.fn();
    subject.requirePolicy = vi.fn().mockResolvedValue(policy);
    subject.supersedeQueuedOperations = vi.fn();
    subject.insertOperation = vi.fn(async (_tx, input) => ({ id: 'operation', ...input }));
    subject.kick = vi.fn();
    await subject.queueLifecycle('policy', 'start', null);
    await subject.queueLifecycle('policy', 'start', null);
    const inputs = subject.insertOperation.mock.calls.map((call: any[]) => call[1]);
    expect(inputs[0]).toMatchObject({ type: 'start', targetGeneration: 7 });
    expect(inputs[0].idempotencyKey).not.toBe(inputs[1].idempotencyKey);
    expect(set.mock.calls[0][0]).not.toHaveProperty('desiredGeneration');
    expect(subject.supersedeQueuedOperations).toHaveBeenCalledTimes(2);
  });

  it.each([
    'container',
    'deployment',
    'compose',
  ])('%s stop/start and restart preserve existing placement and runtime IDs', async (kind) => {
    const subject = service();
    const placements = ['a', 'b'].map((id) => ({
      id,
      policyId: 'policy',
      nodeId: id,
      generation: 7,
      specFingerprint: 'runtime-fingerprint',
      actualState: 'serving',
      desiredState: 'serving',
      serving: true,
      runtimeIdentity: { containerId: `existing-${id}` },
      operationId: '',
    }));
    const policy = {
      id: 'policy',
      resourceKind: kind,
      mode: 'replicated',
      desiredReplicaCount: 2,
      shouldRun: true,
      desiredGeneration: 7,
    };
    const where = vi.fn(() => ({ orderBy: vi.fn().mockResolvedValue(placements) }));
    subject.db = { select: () => ({ from: () => ({ where }) }), update: () => ({ set: () => ({ where: vi.fn() }) }) };
    subject.requirePolicy = vi.fn().mockResolvedValue(policy);
    subject.resolvePolicyResource = vi.fn().mockResolvedValue({ kind, specFingerprint: 'canonical-fingerprint' });
    subject.nodeRegistry = { getNode: vi.fn().mockReturnValue({}) };
    subject.updateOperationPhase = vi.fn();
    subject.requireActiveLeaseOwner = vi.fn().mockReturnValue('lease');
    subject.completeLifecycleSnapshots = vi.fn();
    subject.artifacts = { prepare: vi.fn(), releaseObsoletePins: vi.fn() };
    const result = (context: any, running: boolean) => ({
      acknowledgedGeneration: 7,
      serving: running,
      actualState: running ? 'serving' : 'stopped',
      runtimeIdentity: { containerId: `existing-${context.placementId}` },
    });
    const adapter = {
      stopPlacement: vi.fn(async (c) => result(c, false)),
      startPlacement: vi.fn(async (c) => result(c, true)),
      ensurePlacement: vi.fn(),
      removePlacement: vi.fn(),
    };
    subject.requireAdapter = vi.fn().mockReturnValue(adapter);
    subject.persistPlacementResult = vi.fn(async (id, operation, _resource, value) => {
      Object.assign(placements.find((p) => p.id === id)!, value, { operationId: operation.id });
    });
    for (const type of ['stop', 'start', 'restart']) {
      policy.shouldRun = type !== 'stop';
      await subject.executeLifecycle({ id: type, type, policyId: 'policy', targetGeneration: 7, idempotencyKey: type });
      expect(subject.updateOperationPhase).toHaveBeenCalledWith(
        type,
        type === 'stop' ? 'stopping' : type === 'start' ? 'starting' : 'restarting'
      );
      expect(placements.map((p) => [p.id, p.runtimeIdentity.containerId, p.generation])).toEqual([
        ['a', 'existing-a', 7],
        ['b', 'existing-b', 7],
      ]);
      expect(placements.every((p) => p.serving === (type !== 'stop'))).toBe(true);
    }
    // Replaying a completed restart does not stop the just-restarted containers again.
    await subject.executeLifecycle({
      id: 'restart',
      type: 'restart',
      policyId: 'policy',
      targetGeneration: 7,
      idempotencyKey: 'restart',
    });
    expect(adapter.stopPlacement).toHaveBeenCalledTimes(4);
    expect(adapter.startPlacement).toHaveBeenCalledTimes(4);
    expect(adapter.ensurePlacement).not.toHaveBeenCalled();
    expect(adapter.removePlacement).not.toHaveBeenCalled();
    expect(subject.artifacts.prepare).not.toHaveBeenCalled();
  });

  it.each(['container', 'compose'])('publishes intentionally stopped %s logical surfaces', async (kind) => {
    const subject = service();
    subject.activeLifecycleTypes = vi.fn().mockResolvedValue(new Map());
    const policy = {
      id: 'policy',
      shouldRun: false,
      mode: 'replicated',
      resourceKind: kind,
      status: 'healthy',
      desiredReplicaCount: 2,
      containerName: 'app',
      composeProjectId: 'project',
      portableSpec: { image: 'nginx:alpine' },
    };
    let read = 0;
    subject.db = { select: () => ({ from: () => ({ where: () => Promise.resolve(read++ === 0 ? [policy] : []) }) }) };
    const result =
      kind === 'compose'
        ? await subject.listComposeSurfaceStates(['project'])
        : await subject.listContainerSurfaceStates('node', [{ name: 'app' }]);
    expect(Object.values(result)[0]).toMatchObject({
      stopped: true,
      status: 'stopped',
      healthStatus: 'stopped',
      serving: 0,
    });
  });

  describe.each(['container', 'deployment', 'compose'])('%s list lifecycle status', (kind) => {
    it.each([
      { type: 'start', operationStatus: 'pending', shouldRun: true, status: 'starting' },
      { type: 'stop', operationStatus: 'pending', shouldRun: false, status: 'stopping' },
      { type: 'restart', operationStatus: 'running', shouldRun: true, status: 'restarting' },
      { type: 'start', operationStatus: 'waiting', shouldRun: true, status: 'starting' },
      { type: 'stop', operationStatus: 'completed', shouldRun: false, status: 'stopped' },
      { type: 'start', operationStatus: 'failed', shouldRun: true, status: 'offline' },
      { type: 'stop', operationStatus: 'cancelled', shouldRun: false, status: 'stopped' },
    ])('projects $operationStatus $type as $status', async ({ type, operationStatus, shouldRun, status }) => {
      const subject = service();
      const policy = {
        id: 'policy',
        shouldRun,
        desiredGeneration: 7,
        mode: 'replicated',
        resourceKind: kind,
        status: operationStatus === 'failed' ? 'unavailable' : 'healthy',
        desiredReplicaCount: 2,
        containerName: 'app',
        deploymentId: 'deployment',
        composeProjectId: 'project',
        portableSpec: { image: 'nginx:alpine' },
      };
      const operations = ['pending', 'running', 'waiting'].includes(operationStatus)
        ? [{ policyId: 'policy', type, targetGeneration: 7 }]
        : [];
      subject.db = {
        select: () => ({
          from: (table: unknown) => ({
            where: () =>
              table === dockerAvailabilityOperations
                ? { orderBy: vi.fn().mockResolvedValue(operations) }
                : Promise.resolve(table === dockerAvailabilityPlacements ? [] : [policy]),
          }),
        }),
      };
      const result =
        kind === 'compose'
          ? await subject.listComposeSurfaceStates(['project'])
          : await subject.listContainerSurfaceStates('node', [
              { name: 'app', ...(kind === 'deployment' ? { deploymentId: 'deployment' } : {}) },
            ]);
      expect(Object.values(result)[0]).toMatchObject({
        status,
        stopped: !shouldRun,
        ...(!shouldRun ? { healthStatus: 'stopped' } : {}),
      });
    });
  });

  it('uses the newest active lifecycle per policy and ignores obsolete generations', async () => {
    const subject = service();
    const orderBy = vi.fn().mockResolvedValue([
      { policyId: 'a', type: 'stop', targetGeneration: 6 },
      { policyId: 'a', type: 'restart', targetGeneration: 7 },
      { policyId: 'a', type: 'start', targetGeneration: 7 },
      { policyId: 'b', type: 'stop', targetGeneration: 2 },
    ]);
    subject.db = { select: () => ({ from: () => ({ where: () => ({ orderBy }) }) }) };
    expect(
      await subject.activeLifecycleTypes([
        { id: 'a', desiredGeneration: 7 },
        { id: 'b', desiredGeneration: 2 },
      ])
    ).toEqual(
      new Map([
        ['a', 'restart'],
        ['b', 'stop'],
      ])
    );
    expect(orderBy).toHaveBeenCalledOnce();
  });

  it('updates deployment/slot and Compose snapshots and emits resource events on completion', async () => {
    const subject = service();
    const updates: Array<{ table: unknown; patch: any }> = [];
    subject.db = {
      update: (table: unknown) => ({
        set: (patch: any) => {
          updates.push({ table, patch });
          return { where: vi.fn() };
        },
      }),
    };
    await subject.completeLifecycleSnapshots({ deploymentId: 'deployment', originNodeId: 'node' }, false);
    await subject.completeLifecycleSnapshots({ composeProjectId: 'project', originNodeId: 'node' }, false);
    expect(updates).toContainEqual({ table: dockerDeployments, patch: expect.objectContaining({ status: 'stopped' }) });
    expect(updates).toContainEqual({
      table: dockerDeploymentSlots,
      patch: expect.objectContaining({ status: 'stopped', health: 'unknown' }),
    });
    expect(updates).toContainEqual({
      table: dockerComposeProjects,
      patch: expect.objectContaining({ status: 'stopped', desiredState: 'stopped' }),
    });
    expect(subject.events.publish).toHaveBeenCalledWith(
      'docker.deployment.changed',
      expect.objectContaining({ action: 'stopped' })
    );
    expect(subject.events.publish).toHaveBeenCalledWith(
      'docker.compose.changed',
      expect.objectContaining({ action: 'stopped' })
    );
  });
});

describe('stopped HA scale-down', () => {
  function fixture(kind = 'container') {
    const subject = service();
    // Deliberately put the source last: array order must not cause its deletion.
    const placements = ['replica-a', 'replica-b', 'source'].map((id) => ({
      id,
      nodeId: id,
      policyId: 'policy',
      generation: 7,
      desiredState: 'stopped',
      actualState: 'stopped',
      serving: false,
      specFingerprint: 'runtime-spec',
      runtimeIdentity: { containerId: `runtime-${id}` },
      dependencyState: 'ready',
      applicationHealth: 'unknown',
      operationId: 'old-stop',
    }));
    const policy = {
      id: 'policy',
      resourceKind: kind,
      mode: 'replicated',
      shouldRun: false,
      desiredReplicaCount: 2,
      desiredGeneration: 8,
      rolloutPolicy: { drainSeconds: 30 },
      status: 'scaling',
    };
    const resource = { kind, currentNodeId: 'source', running: false, specFingerprint: 'runtime-spec' };
    const sqlValues = (condition: any): unknown[] =>
      (condition?.queryChunks ?? []).flatMap((chunk: any) =>
        chunk?.queryChunks ? sqlValues(chunk) : chunk?.value !== undefined ? [chunk.value] : []
      );
    subject.db = {
      select: () => ({
        from: () => ({
          where: (condition: unknown) => {
            const snapshot = placements.map((placement) => ({ ...placement }));
            return Object.assign(Promise.resolve(snapshot), {
              orderBy: async () => snapshot,
              limit: async () => snapshot.filter((placement) => sqlValues(condition).includes(placement.id)),
            });
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (patch: any) => ({
          where: async (condition: any) => {
            if (table === dockerAvailabilityPolicies) Object.assign(policy, patch);
            if (table === dockerAvailabilityPlacements) {
              const ids = sqlValues(condition);
              for (const placement of placements) if (ids.includes(placement.id)) Object.assign(placement, patch);
            }
          },
        }),
      }),
    };
    subject.requirePolicy = vi.fn().mockResolvedValue(policy);
    subject.resolvePolicyResource = vi
      .fn()
      .mockImplementation(async () => ({ ...resource, running: policy.shouldRun }));
    subject.requireActiveLeaseOwner = vi.fn().mockReturnValue('lease');
    subject.updateOperationPhase = vi.fn();
    subject.completeLifecycleSnapshots = vi.fn();
    subject.queueOperation = vi.fn();
    subject.publishPolicy = vi.fn();
    subject.nodeRegistry = { getNode: vi.fn().mockReturnValue({}) };
    const result = (c: any, running: boolean) => ({
      acknowledgedGeneration: c.generation,
      actualState: running ? 'serving' : 'stopped',
      serving: running,
      dependencyState: 'ready',
      applicationHealth: running ? 'healthy' : 'unknown',
      runtimeIdentity: { containerId: `runtime-${c.placementId}` },
    });
    const adapter = {
      stopPlacement: vi.fn(async (c) => result(c, false)),
      startPlacement: vi.fn(async (c) => result(c, true)),
      drainPlacement: vi.fn(),
      removePlacement: vi.fn(),
      ensurePlacement: vi.fn(),
    };
    subject.requireAdapter = vi.fn().mockReturnValue(adapter);
    const operation = { id: 'scale', type: 'scale', policyId: 'policy', targetGeneration: 8, idempotencyKey: 'scale' };
    return { subject, placements, policy, resource, adapter, operation };
  }

  it.each([
    'container',
    'deployment',
    'compose',
  ])('removes surplus stopped %s and starts the same two survivors', async (kind) => {
    const { subject, placements, policy, resource, adapter, operation } = fixture(kind);
    await subject.executeStoppedReconcile(operation, policy, resource, adapter);
    expect(adapter.startPlacement).not.toHaveBeenCalled();
    expect(adapter.ensurePlacement).not.toHaveBeenCalled();
    expect(adapter.removePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ placementId: 'replica-b', generation: 8 })
    );
    expect(adapter.drainPlacement).toHaveBeenCalledWith(expect.anything(), 0);
    const survivors = placements.filter((placement) => placement.actualState !== 'removed');
    expect(survivors.map((placement) => placement.id)).toEqual(['replica-a', 'source']);
    expect(survivors.every((placement) => placement.actualState === 'stopped')).toBe(true);
    policy.shouldRun = true;
    await subject.executeLifecycle({ ...operation, id: 'start', type: 'start', idempotencyKey: 'start' });
    expect(adapter.startPlacement).toHaveBeenCalledTimes(2);
    expect(survivors.map((placement) => placement.runtimeIdentity.containerId)).toEqual([
      'runtime-replica-a',
      'runtime-source',
    ]);
    expect(adapter.removePlacement).toHaveBeenCalledTimes(1);
  });

  it('cleans up a leftover stopped surplus during Start instead of leaving it forever', async () => {
    const { subject, placements, policy, adapter, operation } = fixture();
    policy.shouldRun = true;
    for (const placement of placements) placement.generation = 8;
    await subject.executeLifecycle({ ...operation, id: 'start', type: 'start' });
    expect(adapter.startPlacement.mock.calls.map((call: any[]) => call[0].placementId)).toEqual([
      'source',
      'replica-a',
    ]);
    expect(placements.find((placement) => placement.id === 'replica-b')?.actualState).toBe('removed');
    expect(adapter.ensurePlacement).not.toHaveBeenCalled();
  });

  it.each([
    'replicated',
    'failover',
  ])('automatically queues same-generation surplus cleanup for a healthy %s policy', async (mode) => {
    const { subject, placements, policy } = fixture();
    policy.shouldRun = true;
    policy.status = 'healthy';
    policy.mode = mode;
    policy.desiredGeneration = 44;
    policy.desiredReplicaCount = mode === 'replicated' ? 2 : 1;
    for (const placement of placements) {
      placement.generation = 44;
      placement.serving = placement.id === 'source' || (mode === 'replicated' && placement.id === 'replica-a');
      placement.actualState = placement.serving ? 'serving' : 'stopped';
    }
    subject.licensePolicy = { hasFeature: vi.fn().mockResolvedValue(true) };
    await subject.queueHealIfNeeded('policy');
    expect(subject.queueOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'heal',
        targetGeneration: 44,
        requestedPolicy: { cleanupOnly: true },
      })
    );
    expect(policy.desiredGeneration).toBe(44);
  });

  it('auto-cleanup removes the same-generation stopped extra without touching serving runtimes or images', async () => {
    const { subject, placements, policy, adapter, operation } = fixture();
    policy.shouldRun = true;
    policy.desiredGeneration = 44;
    for (const placement of placements) {
      placement.generation = 44;
      placement.serving = placement.id !== 'replica-b';
      placement.actualState = placement.serving ? 'serving' : 'stopped';
    }
    subject.artifacts = { prepare: vi.fn() };
    await subject.executeReconcile({
      ...operation,
      type: 'heal',
      targetGeneration: 44,
      requestedPolicy: { cleanupOnly: true },
    });
    expect(adapter.removePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ placementId: 'replica-b', generation: 44 })
    );
    expect(placements.find((placement) => placement.id === 'replica-b')?.actualState).toBe('removed');
    expect(
      placements.filter((placement) => placement.serving).map((placement) => placement.runtimeIdentity.containerId)
    ).toEqual(['runtime-replica-a', 'runtime-source']);
    expect(adapter.ensurePlacement).not.toHaveBeenCalled();
    expect(adapter.startPlacement).not.toHaveBeenCalled();
    expect(adapter.stopPlacement).not.toHaveBeenCalled();
    expect(subject.artifacts.prepare).not.toHaveBeenCalled();
  });

  it.each([
    'failed',
    'unreachable',
  ])('exposes %s surplus removal as cleanup pending and retries safely', async (failure) => {
    const { subject, placements, policy, resource, adapter, operation } = fixture();
    if (failure === 'failed') adapter.removePlacement.mockRejectedValueOnce(new Error('cannot remove runtime'));
    else subject.nodeRegistry.getNode.mockImplementation((id: string) => (id === 'replica-b' ? undefined : {}));
    await expect(subject.executeStoppedReconcile(operation, policy, resource, adapter)).rejects.toMatchObject({
      code: 'AVAILABILITY_SCALE_CLEANUP_PENDING',
      details: { retryable: true, placementIds: ['replica-b'] },
    });
    expect(placements.find((placement) => placement.id === 'replica-b')).toMatchObject({
      actualState: 'cleanup_pending',
      desiredState: 'removed',
    });
    expect(subject.queueOperation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stale_cleanup', requestedPolicy: { placementId: 'replica-b' } })
    );
    expect(subject.publishPolicy).not.toHaveBeenCalledWith('policy', 'stopped');
    expect(policy.status).toBe('scaling');
    expect(adapter.startPlacement).not.toHaveBeenCalled();
    subject.nodeRegistry.getNode.mockReturnValue({});
    await subject.executeStoppedReconcile(operation, policy, resource, adapter);
    expect(placements.find((placement) => placement.id === 'replica-b')?.actualState).toBe('removed');
    expect(placements.find((placement) => placement.id === 'source')?.runtimeIdentity.containerId).toBe(
      'runtime-source'
    );
  });

  it('protects an unreachable source instead of deleting it as surplus', async () => {
    const { subject, placements, policy, resource, adapter, operation } = fixture();
    subject.nodeRegistry.getNode.mockImplementation((id: string) => (id === 'source' ? undefined : {}));
    await subject.executeStoppedReconcile(operation, policy, resource, adapter);
    expect(adapter.removePlacement).not.toHaveBeenCalledWith(expect.objectContaining({ placementId: 'source' }));
    expect(placements.find((placement) => placement.id === 'source')).toMatchObject({
      actualState: 'unreachable',
      desiredState: 'stopped',
    });
  });

  it.each([
    'failed',
    'unreachable',
  ])('keeps deferred cleanup pending when the background retry is %s', async (failure) => {
    const { subject, placements, adapter, operation } = fixture();
    const extra = placements.find((placement) => placement.id === 'replica-b')!;
    extra.desiredState = 'removed';
    extra.actualState = 'cleanup_pending';
    if (failure === 'failed') adapter.removePlacement.mockRejectedValue(new Error('removal failed'));
    else subject.nodeRegistry.getNode.mockReturnValue(undefined);
    subject.refreshPolicyAfterStaleCleanup = vi.fn();
    await expect(
      subject.executeStaleCleanup({ ...operation, type: 'stale_cleanup', requestedPolicy: { placementId: extra.id } })
    ).rejects.toThrow();
    expect(extra.actualState).toBe('cleanup_pending');
    expect(extra.desiredState).toBe('removed');
    expect(subject.refreshPolicyAfterStaleCleanup).not.toHaveBeenCalled();
    expect(subject.publishPolicy).not.toHaveBeenCalledWith('policy', 'stale_removed', extra.nodeId);
  });
});

const context = {
  policyId: 'policy',
  placementId: 'placement',
  operationId: 'operation',
  nodeId: 'node',
  generation: 7,
  idempotencyKey: 'lifecycle',
  resource: {
    kind: 'container',
    resourceId: 'app',
    displayName: 'app',
    currentNodeId: 'node',
    specFingerprint: 'fingerprint',
    portableSpec: {},
    running: true,
  },
};

function stubFences(adapter: any) {
  adapter.claimAndFence = vi.fn();
  adapter.fence = vi.fn();
  adapter.inspectOptional = vi.fn().mockResolvedValue({ generation: 7, runtimeIdentity: {} });
  adapter.daemon = vi.fn().mockResolvedValue({ generation: 7 });
}

describe('HA lifecycle adapters never recreate runtimes', () => {
  it('never starts a foreign container or publishes it as healthy', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify({
          Id: 'foreign',
          Config: {
            Labels: {
              'wiolett.gateway.availability.policy': 'other-policy',
              'wiolett.gateway.availability.placement': 'other-placement',
            },
          },
        }),
      }),
    };
    const projector = { prepare: vi.fn(), activate: vi.fn() };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      {} as never,
      {} as never,
      projector as never
    ) as any;
    stubFences(adapter);
    await expect(adapter.startPlacement(context)).rejects.toMatchObject({
      code: 'AVAILABILITY_CONTAINER_NAME_CONFLICT',
    });
    expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledTimes(1);
    expect(projector.activate).not.toHaveBeenCalled();
  });

  it.each(['deployment', 'compose'])('rejects missing %s containers without any runtime mutation', async (kind) => {
    const dispatch = {
      sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true, detail: '[]' }),
      sendDockerDeploymentCommand: vi.fn().mockResolvedValue({ success: true, detail: '{"containers":[]}' }),
      sendDockerComposeCommand: vi.fn(),
    };
    const projector = { prepare: vi.fn(), activate: vi.fn() };
    const Adapter = kind === 'deployment' ? DockerDeploymentAvailabilityAdapter : DockerComposeAvailabilityAdapter;
    const adapter = new Adapter({} as never, dispatch as never, {} as never, projector as never) as any;
    stubFences(adapter);
    await expect(
      adapter.startPlacement({
        ...context,
        resource: {
          ...context.resource,
          kind,
          portableSpec: { routerName: 'router', slots: { blue: 'blue', green: 'green' } },
        },
      })
    ).rejects.toMatchObject({
      code: kind === 'deployment' ? 'AVAILABILITY_DEPLOYMENT_NAME_CONFLICT' : 'AVAILABILITY_COMPOSE_NAME_CONFLICT',
    });
    expect(dispatch.sendDockerComposeCommand).not.toHaveBeenCalled();
    expect(dispatch.sendDockerDeploymentCommand.mock.calls.every((call: unknown[]) => call[1] === 'inspect')).toBe(
      true
    );
    expect(projector.activate).not.toHaveBeenCalled();
  });

  it('stops then starts the exact existing container, with readiness before route activation', async () => {
    let running = true;
    const dispatch = {
      sendDockerContainerCommand: vi.fn(async (_node, action) => {
        if (action === 'start') running = true;
        if (action === 'stop') running = false;
        return {
          success: true,
          detail: JSON.stringify({
            Id: 'original-id',
            Name: '/app',
            State: { Running: running, Health: { Status: 'healthy' } },
          }),
        };
      }),
    };
    const projector = { prepare: vi.fn().mockResolvedValue({}), deactivate: vi.fn(), activate: vi.fn() };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      {} as never,
      {} as never,
      projector as never
    ) as any;
    stubFences(adapter);
    const stopped = await adapter.stopPlacement(context);
    adapter.inspectOptional.mockResolvedValue({ generation: 7, runtimeIdentity: stopped.runtimeIdentity });
    const started = await adapter.startPlacement(context);
    expect(started.runtimeIdentity).toEqual(stopped.runtimeIdentity);
    expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith('node', 'start', { containerId: 'original-id' });
    expect(dispatch.sendDockerContainerCommand.mock.calls.map((c) => c[1])).toEqual([
      'inspect',
      'stop',
      'inspect',
      'inspect',
      'start',
      'inspect',
    ]);
    expect(projector.activate).toHaveBeenCalledOnce();
  });

  it('fails a missing container without create, remove, or route activation', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: false, error: 'no such container' }),
    };
    const projector = { prepare: vi.fn(), activate: vi.fn() };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      {} as never,
      {} as never,
      projector as never
    ) as any;
    stubFences(adapter);
    await expect(adapter.startPlacement(context)).rejects.toMatchObject({
      code: 'AVAILABILITY_CONTAINER_INSPECT_FAILED',
    });
    expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledTimes(1);
    expect(projector.activate).not.toHaveBeenCalled();
  });

  it('starts the existing deployment active slot, even when the original image was a tag', async () => {
    let running = false;
    const rows = () =>
      ['router', 'blue', 'green'].map((role) => ({
        id: `original-${role}`,
        name: role,
        state: running && role !== 'green' ? 'running' : 'exited',
        image: 'nginx:alpine',
        imageId: `sha256:${'a'.repeat(64)}`,
        labels: {
          'wiolett.gateway.deployment.id': 'app',
          'wiolett.gateway.deployment.managed': 'true',
          'wiolett.gateway.deployment.role': role === 'router' ? 'router' : 'app',
          'wiolett.gateway.deployment.slot': role,
        },
      }));
    const dispatch = {
      sendDockerDeploymentCommand: vi.fn(async (_node, action) => {
        if (action === 'start') running = true;
        return {
          success: true,
          detail: JSON.stringify(action === 'inspect' ? { containers: rows() } : { containerId: 'original-blue' }),
        };
      }),
    };
    const adapter = new DockerDeploymentAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      { prepare: vi.fn().mockResolvedValue({}), activate: vi.fn() } as never
    ) as any;
    stubFences(adapter);
    const result = await adapter.startPlacement({
      ...context,
      resource: {
        ...context.resource,
        kind: 'deployment',
        portableSpec: {
          activeSlot: 'blue',
          routerName: 'router',
          networkName: 'net',
          slots: { blue: 'blue', green: 'green' },
        },
      },
    });
    expect(result.runtimeIdentity).toMatchObject({ containerId: 'original-blue', activeSlot: 'blue' });
    expect(dispatch.sendDockerDeploymentCommand.mock.calls.map((c) => c[1])).toEqual(['inspect', 'start', 'inspect']);
  });

  it('starts stopped Compose services without pull/apply and preserves their IDs', async () => {
    let running = false;
    const rows = () => [
      {
        id: 'original-web',
        name: 'app-web',
        imageId: `sha256:${'a'.repeat(64)}`,
        labels: {
          'com.docker.compose.project': 'app',
          'com.docker.compose.service': 'web',
          'wiolett.gateway.compose.project-id': 'app',
          'wiolett.gateway.compose.managed': 'true',
        },
      },
    ];
    const dispatch = {
      sendDockerComposeCommand: vi.fn(async () => {
        running = true;
        return { success: true };
      }),
      sendDockerContainerCommand: vi.fn(async (_node, action) => ({
        success: true,
        detail: JSON.stringify(
          action === 'list' ? rows() : { State: { Running: running, Health: { Status: 'healthy' } } }
        ),
      })),
    };
    const adapter = new DockerComposeAvailabilityAdapter(
      {} as never,
      dispatch as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      { prepare: vi.fn().mockResolvedValue({}), activate: vi.fn() } as never
    ) as any;
    stubFences(adapter);
    const result = await adapter.startPlacement({
      ...context,
      resource: {
        ...context.resource,
        kind: 'compose',
        portableSpec: { yaml: 'services: {}', normalizedModel: { services: { web: { image: 'nginx:alpine' } } } },
      },
    });
    expect(result.runtimeIdentity.containers).toEqual([expect.objectContaining({ containerId: 'original-web' })]);
    expect(dispatch.sendDockerComposeCommand).toHaveBeenCalledOnce();
    expect(dispatch.sendDockerComposeCommand).toHaveBeenCalledWith(
      'node',
      'start',
      expect.objectContaining({ removeOrphans: false })
    );
  });
});
