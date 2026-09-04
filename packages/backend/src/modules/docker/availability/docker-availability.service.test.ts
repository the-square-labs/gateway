import { describe, expect, it, vi } from 'vitest';
import { dockerAvailabilityPlacements, dockerAvailabilityPolicies } from '@/db/schema/index.js';
import { EventBusService } from '@/services/event-bus.service.js';
import {
  DockerAvailabilityService,
  initialAvailabilityPlacementState,
  isCurrentServingAvailabilityPlacement,
  resolveAvailabilityLogicalSurfaceState,
  sanitizeAvailabilityErrorMessage,
  shouldReconcileAvailabilityResourceDrift,
} from './docker-availability.service.js';

function service() {
  return new DockerAvailabilityService(
    {} as never,
    {} as never,
    {} as never,
    { log: vi.fn() } as never,
    new EventBusService()
  ) as any;
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('removed ordinary HA survivor', () => {
  it('blocks re-enabling a same-name resource while old cleanup is pending', async () => {
    const subject = service();
    subject.preflight = vi.fn().mockResolvedValue({ eligible: true });
    subject.requireAdapter = vi.fn().mockReturnValue({ resolve: vi.fn().mockResolvedValue({}) });
    subject.normalizePolicyInput = vi.fn().mockReturnValue({});
    subject.lockResource = vi.fn();
    subject.findPolicyByResolvedResource = vi
      .fn()
      .mockResolvedValue({ mode: 'single', portableSpec: { removedContainer: true } });
    const tx = { update: vi.fn(), insert: vi.fn() };
    subject.db = { transaction: async (run: (value: typeof tx) => Promise<unknown>) => run(tx) };
    await expect(subject.enable({ resource: { type: 'container' } }, 'user', [])).rejects.toMatchObject({
      code: 'AVAILABILITY_CLEANUP_PENDING',
    });
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });
  it.each([
    'single',
    'replicated',
    'failover',
    null,
  ])('only cleans a deleted single-mode container (%s)', async (mode) => {
    const subject = service();
    subject.findPolicyByResourceReference = vi.fn().mockResolvedValue(
      mode
        ? {
            id: 'policy',
            resourceKind: 'container',
            mode,
            status: 'healthy',
            containerName: 'api',
            sourceNodeId: 'node',
          }
        : null
    );
    const set = vi.fn(() => ({ where: vi.fn() }));
    const tx = { update: vi.fn(() => ({ set })) };
    subject.db = { transaction: vi.fn(async (run) => run(tx)) };
    subject.lockPolicy = vi.fn();
    subject.requirePolicy = vi.fn().mockResolvedValue({ mode, status: 'healthy', portableSpec: { image: 'nginx' } });
    subject.cleanupRemovedContainers = vi.fn();
    await subject.containerRemoved('node', 'api');
    if (mode === 'single') {
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ portableSpec: { image: 'nginx', removedContainer: true } })
      );
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ actualState: 'removed' }));
      expect(subject.cleanupRemovedContainers).toHaveBeenCalled();
    } else {
      expect(subject.db.transaction).not.toHaveBeenCalled();
      expect(subject.cleanupRemovedContainers).not.toHaveBeenCalled();
    }
  });

  it.each(['placement', 'operation', 'none'])('retains cleanup ownership until %s work is gone', async (pending) => {
    const subject = service();
    const where = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'policy' }])
      .mockResolvedValueOnce(pending === 'placement' ? [{ id: 'retired' }] : [])
      .mockResolvedValueOnce(pending === 'operation' ? [{ id: 'cleanup' }] : []);
    subject.db = { select: () => ({ from: () => ({ where }) }), delete: vi.fn(() => ({ where: vi.fn() })) };
    subject.artifacts = { cleanup: vi.fn() };
    await subject.cleanupRemovedContainers();
    expect(subject.db.delete).toHaveBeenCalledTimes(pending === 'none' ? 1 : 0);
    expect(subject.artifacts.cleanup).toHaveBeenCalledTimes(pending === 'none' ? 1 : 0);
  });

  it('retries failed artifact cleanup without losing the persisted policy', async () => {
    const subject = service();
    const where = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'policy' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'policy' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    subject.db = { select: () => ({ from: () => ({ where }) }), delete: vi.fn(() => ({ where: vi.fn() })) };
    subject.artifacts = {
      cleanup: vi.fn().mockRejectedValueOnce(new Error('relay offline')).mockResolvedValueOnce(undefined),
    };
    await expect(subject.cleanupRemovedContainers()).rejects.toThrow('relay offline');
    expect(subject.db.delete).not.toHaveBeenCalled();
    await subject.cleanupRemovedContainers();
    expect(subject.artifacts.cleanup).toHaveBeenCalledTimes(2);
    expect(subject.db.delete).toHaveBeenCalledOnce();
  });
});

describe('resolveAvailabilityLogicalSurfaceState', () => {
  it('retries a typed gRPC unavailable error after relay interruption', () => {
    const error = Object.assign(new Error('14 UNAVAILABLE: relay connection refused'), { code: 14 });
    expect(service().normalizeError(error)).toMatchObject({
      code: 'AVAILABILITY_TRANSPORT_UNAVAILABLE',
      retryable: true,
    });
  });

  it.each([3, 7, 16, undefined])('does not retry non-transport failure code %s', (code) => {
    const error = Object.assign(new Error('operation rejected'), { code });
    expect(service().normalizeError(error)).toMatchObject({ retryable: false });
  });

  it('keeps every planned mutation online while presenting one rolling-out status', () => {
    for (const status of ['enabling', 'scaling', 'rolling_out', 'disabling'] as const) {
      expect(resolveAvailabilityLogicalSurfaceState(status, 0, 2)).toEqual({
        status: 'rolling_out',
        healthStatus: 'online',
      });
    }
  });

  it('reports stable logical health after the operation completes', () => {
    expect(resolveAvailabilityLogicalSurfaceState('healthy', 2, 2)).toEqual({
      status: 'online',
      healthStatus: 'online',
    });
    expect(resolveAvailabilityLogicalSurfaceState('healthy', 1, 2)).toEqual({
      status: 'degraded',
      healthStatus: 'degraded',
    });
    expect(resolveAvailabilityLogicalSurfaceState('healthy', 0, 2)).toEqual({
      status: 'offline',
      healthStatus: 'offline',
    });
  });

  it('resolves a container policy from any active placement node', async () => {
    const subject = service();
    const policy = { id: 'policy-1', resourceKind: 'container', containerName: 'api' };
    subject.workloads = { findPolicy: vi.fn().mockResolvedValue(policy) };

    await expect(
      subject.findPolicyByResourceReference({ type: 'container', nodeId: 'replica-node', containerName: 'api' })
    ).resolves.toEqual(policy);
  });
});

describe('initialAvailabilityPlacementState', () => {
  it('never treats a physical source runtime as a ready HA placement before reconciliation', () => {
    expect(initialAvailabilityPlacementState(true)).toEqual({
      desiredState: 'serving',
      actualState: 'pending',
      serving: false,
      dependencyState: 'pending',
      applicationHealth: 'unknown',
    });
    expect(initialAvailabilityPlacementState(false)).toEqual({
      desiredState: 'stopped',
      actualState: 'pending',
      serving: false,
      dependencyState: 'pending',
      applicationHealth: 'unknown',
    });
  });
});

describe('isCurrentServingAvailabilityPlacement', () => {
  it('does not retain a stale-generation placement before runtime reconciliation', () => {
    expect(
      isCurrentServingAvailabilityPlacement({ generation: 9, serving: true, actualState: 'serving' }, 10, true)
    ).toBe(false);
    expect(
      isCurrentServingAvailabilityPlacement({ generation: 10, serving: true, actualState: 'serving' }, 10, true)
    ).toBe(true);
  });
});

const baseInput = {
  resource: { type: 'deployment' as const, deploymentId: 'deployment-1' },
  mode: 'replicated' as const,
  desiredReplicaCount: 2,
  nodeSelectionMode: 'selected' as const,
  selectedNodeIds: ['node-b', 'node-a'],
  rolloutPolicy: { maxUnavailable: 0, maxSurge: 1, drainSeconds: 30 },
  offlineReplacementGraceSeconds: 15,
};

describe('DockerAvailabilityService policy contracts', () => {
  it('reconciles enabled policies after startup even when nodes were already persisted online', async () => {
    vi.useFakeTimers();
    try {
      const subject = service();
      subject.recoverInterruptedOperations = vi.fn().mockResolvedValue(undefined);
      subject.reconcileEnabledPoliciesAfterStartup = vi.fn().mockResolvedValue(undefined);

      subject.start();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(subject.reconcileEnabledPoliciesAfterStartup).toHaveBeenCalledOnce();
      subject.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps an internal container placement back to the logical container access identity', async () => {
    const subject = service();
    subject.workloads = {
      findRuntimeOwner: vi.fn().mockResolvedValue({
        workload: {
          policy: {
            id: 'policy-1',
            mode: 'replicated',
            resourceKind: 'container',
            containerName: 'api',
          },
          managementTarget: { nodeId: 'origin-node', resourceId: 'api' },
        },
      }),
      resolve: vi.fn().mockResolvedValue(null),
    };

    await expect(subject.resolveRuntimeAccessIdentity('runtime-node', 'runtime-container')).resolves.toEqual({
      nodeId: 'origin-node',
      resourceId: 'api',
    });
  });

  it('finds a container policy by an active placement runtime name', async () => {
    const subject = service();
    const policy = {
      id: 'policy-1',
      resourceKind: 'container',
      containerName: 'api',
    };
    subject.workloads = { findPolicy: vi.fn().mockResolvedValue(policy) };

    await expect(
      subject.findPolicyByResourceReference({
        type: 'container',
        nodeId: 'runtime-node',
        containerName: 'gwav-container-policy-placement',
      })
    ).resolves.toEqual(policy);
  });

  it('maps an internal deployment slot back to the logical deployment access identity', async () => {
    const subject = service();
    subject.workloads = {
      findRuntimeOwner: vi.fn().mockResolvedValue({
        workload: {
          policy: {
            id: 'policy-1',
            mode: 'failover',
            resourceKind: 'deployment',
            deploymentId: 'deployment-1',
          },
          managementTarget: { nodeId: 'origin-node', resourceId: 'deployment-1' },
        },
      }),
      resolve: vi.fn().mockResolvedValue(null),
    };

    await expect(subject.resolveRuntimeAccessIdentity('runtime-node', 'runtime-slot')).resolves.toEqual({
      nodeId: 'origin-node',
      resourceId: 'deployment-1',
    });
  });

  it('maps an internal Compose service container back to the logical service access identity', async () => {
    const subject = service();
    subject.workloads = {
      findRuntimeOwner: vi.fn().mockResolvedValue({
        workload: {
          policy: {
            id: 'policy-1',
            mode: 'replicated',
            resourceKind: 'compose',
            composeProjectId: 'b3e24b62-653f-4440-a83f-423d71c2e21d',
          },
          managementTarget: {
            nodeId: 'origin-node',
            resourceId: 'b3e24b62-653f-4440-a83f-423d71c2e21d',
          },
        },
        composeServiceName: 'api',
      }),
      resolve: vi.fn().mockResolvedValue(null),
    };

    await expect(subject.resolveRuntimeAccessIdentity('runtime-node', 'runtime-container')).resolves.toEqual({
      nodeId: 'origin-node',
      resourceId: 'b3e24b62-653f-4440-a83f-423d71c2e21d:api',
    });
  });

  it('escapes daemon control bytes before persisting operation errors', () => {
    expect(sanitizeAvailabilityErrorMessage('dial unix \u0000\b\u0012ttrpc')).toBe('dial unix \\x00\\x08\\x12ttrpc');
  });

  it('accepts replicated counts from 2 through 32 and rejects values outside the range', () => {
    const subject = service();
    expect(() => subject.validatePolicyInput(baseInput)).not.toThrow();
    expect(() => subject.validatePolicyInput({ ...baseInput, desiredReplicaCount: 32 })).not.toThrow();
    for (const desiredReplicaCount of [1, 33]) {
      expectCode(() => subject.validatePolicyInput({ ...baseInput, desiredReplicaCount }), 'INVALID_REPLICA_COUNT');
    }
  });

  it('requires failover to have one serving placement', () => {
    const subject = service();
    expect(() => subject.validatePolicyInput({ ...baseInput, mode: 'failover', desiredReplicaCount: 1 })).not.toThrow();
    expectCode(
      () => subject.validatePolicyInput({ ...baseInput, mode: 'failover', desiredReplicaCount: 2 }),
      'INVALID_REPLICA_COUNT'
    );
  });

  it('blocks enabling Availability when fewer than two compatible nodes exist', async () => {
    const subject = service();
    const resource = {
      kind: 'deployment',
      reference: baseInput.resource,
      resourceId: 'deployment-1',
      displayName: 'api',
      currentNodeId: 'node-a',
      viewScope: 'docker:containers:view',
      manageScope: 'docker:containers:manage',
      specFingerprint: 'fingerprint',
      portableSpec: {},
      imageReference: 'nginx@sha256:abc',
      running: true,
    };
    subject.licensePolicy = { requireFeature: vi.fn().mockResolvedValue(undefined) };
    subject.findPolicyByResourceReference = vi.fn().mockResolvedValue(null);
    subject.requireAdapter = vi.fn().mockReturnValue({
      resolve: vi.fn().mockResolvedValue(resource),
      preflight: vi.fn().mockResolvedValue({ blockers: [], warnings: [] }),
    });
    subject.assertResourceAccess = vi.fn();
    subject.resolveCandidateNodes = vi.fn().mockResolvedValue([{ id: 'node-a', compatible: true }]);
    subject.collectCandidatePermissionBlockers = vi.fn();
    subject.artifacts = { preflight: vi.fn().mockResolvedValue(undefined) };

    for (const input of [baseInput, { ...baseInput, mode: 'failover' as const, desiredReplicaCount: 1 }]) {
      await expect(subject.preflight(input, ['docker:containers:manage'])).resolves.toMatchObject({
        eligible: false,
        blockers: [
          {
            code: 'INSUFFICIENT_ELIGIBLE_NODES',
            message: '2 compatible Docker nodes are required but only 1 are available',
          },
        ],
      });
    }
  });

  it('updates the canonical source image when a managed container image changes', async () => {
    const subject = service();
    subject.licensePolicy = { requireFeature: vi.fn().mockResolvedValue(undefined) };
    subject.findActiveContainerPolicy = vi.fn().mockResolvedValue({
      id: 'policy-1',
      portableSpec: {
        image: 'nginx:1.29-alpine',
        sourceImageReference: 'nginx:1.29-alpine',
        entrypoint: ['/docker-entrypoint.sh'],
      },
      specFingerprint: 'old-fingerprint',
      imageReference: 'nginx:1.29-alpine',
      shouldRun: true,
    });
    subject.queueCanonicalRollout = vi.fn().mockResolvedValue(undefined);

    await expect(
      subject.updateContainerConfiguration(
        'node-a',
        'api',
        { image: 'traefik/whoami:latest', entrypoint: ['/whoami'] },
        'user-1'
      )
    ).resolves.toBe(true);

    expect(subject.queueCanonicalRollout).toHaveBeenCalledWith(
      'policy-1',
      expect.objectContaining({
        imageReference: 'traefik/whoami:latest',
        portableSpec: expect.objectContaining({
          image: 'traefik/whoami:latest',
          sourceImageReference: 'traefik/whoami:latest',
          entrypoint: ['/whoami'],
        }),
      }),
      'user-1',
      'configuration'
    );
  });

  it('recovers a container policy from a stale source image hint', async () => {
    const subject = service();
    const policy = {
      resourceKind: 'container',
      sourceNodeId: 'node-a',
      originNodeId: 'node-a',
      containerName: 'api',
      deploymentId: null,
      composeProjectId: null,
      displayName: 'api',
      specFingerprint: 'fingerprint',
      portableSpec: {
        image: 'traefik/whoami:latest',
        sourceImageReference: 'nginx:1.29-alpine',
      },
      imageReference: 'traefik/whoami:latest',
      composeRevisionId: null,
      shouldRun: true,
    };

    await expect(subject.resolvePolicyResource(policy)).resolves.toMatchObject({
      imageReference: 'traefik/whoami:latest',
      sourceImageReference: 'traefik/whoami:latest',
    });
  });

  it('recovers a legacy deployment source image from successful release history', async () => {
    const subject = service();
    const limit = vi.fn().mockResolvedValue([{ image: `sha256:${'a'.repeat(64)}` }, { image: 'nginx:alpine' }]);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where: updateWhere }));
    subject.db = { select: vi.fn(() => ({ from })), update: vi.fn(() => ({ set })) };
    subject.artifacts = { resolveCanonicalSourceImage: vi.fn().mockResolvedValue(null) };

    await expect(
      subject.resolveCanonicalSourceImage(
        {
          id: 'policy-1',
          resourceKind: 'deployment',
          deploymentId: 'deployment-1',
          sourceNodeId: 'node-a',
          originNodeId: 'node-a',
          portableSpec: { image: `sha256:${'a'.repeat(64)}` },
          imageReference: `sha256:${'a'.repeat(64)}`,
        },
        `sha256:${'a'.repeat(64)}`
      )
    ).resolves.toBe('nginx:alpine');
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        portableSpec: expect.objectContaining({ sourceImageReference: 'nginx:alpine' }),
      })
    );
  });

  it('wakes a waiting operation when its durable retry deadline arrives', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date('2026-09-02T18:00:00.000Z');
      vi.setSystemTime(now);
      const subject = service();
      const limit = vi.fn().mockResolvedValue([{ nextAttemptAt: new Date(now.getTime() + 30_000) }]);
      const orderBy = vi.fn(() => ({ limit }));
      const where = vi.fn(() => ({ orderBy }));
      const from = vi.fn(() => ({ where }));
      subject.db = { select: vi.fn(() => ({ from })) };
      subject.kick = vi.fn();

      await subject.scheduleNextWaitingOperation();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(subject.kick).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(subject.kick).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('requeues a waiting operation in place when Retry is requested', async () => {
    const subject = service();
    const waiting = {
      id: 'operation-1',
      policyId: 'policy-1',
      type: 'stale_cleanup',
      status: 'waiting',
      retryAttempts: 3,
      requestedPolicy: { placementId: 'placement-1' },
    };
    const initialLimit = vi.fn().mockResolvedValue([waiting]);
    const initialWhere = vi.fn(() => ({ limit: initialLimit }));
    const initialFrom = vi.fn(() => ({ where: initialWhere }));
    const activeLimit = vi.fn().mockResolvedValue([]);
    const activeWhere = vi.fn(() => ({ limit: activeLimit }));
    const activeFrom = vi.fn(() => ({ where: activeWhere }));
    const returning = vi.fn().mockResolvedValue([{ ...waiting, status: 'pending', retryAttempts: 0 }]);
    const updateWhere = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where: updateWhere }));
    const tx = { select: vi.fn(() => ({ from: activeFrom })), update: vi.fn(() => ({ set })) };
    subject.db = {
      select: vi.fn(() => ({ from: initialFrom })),
      transaction: vi.fn(async (callback: (writer: typeof tx) => unknown) => callback(tx)),
    };
    subject.requirePolicy = vi.fn().mockResolvedValue({ id: 'policy-1' });
    subject.resolvePolicyResource = vi.fn().mockResolvedValue({ kind: 'container' });
    subject.assertResourceAccess = vi.fn();
    subject.lockPolicy = vi.fn();
    subject.kick = vi.fn();

    await expect(subject.retryOperation('policy-1', 'operation-1', 'user-1', [])).resolves.toMatchObject({
      id: 'operation-1',
      status: 'pending',
      retryAttempts: 0,
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', retryAttempts: 0, nextAttemptAt: null })
    );
    expect(subject.kick).toHaveBeenCalledOnce();
  });

  it('rejects manual retry after a newer generation supersedes the operation', async () => {
    const subject = service();
    const limit = vi.fn().mockResolvedValue([
      {
        id: 'operation-9',
        policyId: 'policy-1',
        type: 'heal',
        status: 'failed',
        targetGeneration: 9,
        requestedPolicy: {},
      },
    ]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    subject.db = { select: vi.fn(() => ({ from })) };
    subject.requirePolicy = vi.fn().mockResolvedValue({ id: 'policy-1', desiredGeneration: 10 });
    subject.resolvePolicyResource = vi.fn().mockResolvedValue({ kind: 'container' });
    subject.assertResourceAccess = vi.fn();

    await expect(subject.retryOperation('policy-1', 'operation-9', 'user-1', [])).rejects.toMatchObject({
      code: 'AVAILABILITY_OPERATION_SUPERSEDED',
    });
  });

  it('rejects duplicate and empty explicit node selections', () => {
    const subject = service();
    expectCode(
      () => subject.validatePolicyInput({ ...baseInput, selectedNodeIds: ['node-a', 'node-a'] }),
      'DUPLICATE_SELECTED_NODE'
    );
    expectCode(() => subject.validatePolicyInput({ ...baseInput, selectedNodeIds: [] }), 'SELECTED_NODES_REQUIRED');
  });

  it('normalizes selected node order and clears stale selections for all-compatible mode', () => {
    const subject = service();
    expect(subject.normalizePolicyInput(baseInput).selectedNodeIds).toEqual(['node-a', 'node-b']);
    expect(subject.normalizePolicyInput({ ...baseInput, nodeSelectionMode: 'all_compatible' }).selectedNodeIds).toEqual(
      []
    );
  });

  it('ranks higher-capacity nodes first while keeping deterministic ties', () => {
    const subject = service();
    expect(subject.candidateCapacity({ diskFreeBytes: 100, systemMemoryAvailableBytes: 100 })).toBeGreaterThan(
      subject.candidateCapacity({ diskFreeBytes: 10, systemMemoryAvailableBytes: 10 })
    );
    expect(subject.candidateRank('node-a', null, 'policy-1')).toBe(subject.candidateRank('node-a', null, 'policy-1'));
  });

  it('normalizes daemon architectures and rejects unknown cross-node architecture matches', () => {
    const subject = service();
    expect(subject.nodeArchitecture({ architecture: 'x64' })).toBe('amd64');
    expect(subject.nodeArchitecture({ architecture: 'aarch64' })).toBe('arm64');
    expect(subject.nodeArchitecture({})).toBeNull();
  });

  it('requires surge for zero-unavailable Container and Compose rollouts but not local Deployment blue-green', () => {
    const subject = service();
    expect(subject.rolloutExceedsUnavailableBudget('container', true, 3, 3, 0)).toBe(true);
    expect(subject.rolloutExceedsUnavailableBudget('compose', true, 2, 2, 1)).toBe(false);
    expect(subject.rolloutExceedsUnavailableBudget('deployment', true, 1, 1, 0)).toBe(false);
  });

  it('reconstructs a durable rollback resource without changing logical identity', () => {
    const subject = service();
    const fallback = {
      kind: 'deployment',
      reference: { type: 'deployment', deploymentId: 'deployment-1' },
      resourceId: 'deployment-1',
      displayName: 'api',
      currentNodeId: 'node-1',
      viewScope: 'docker:containers:view',
      manageScope: 'docker:containers:manage',
      specFingerprint: 'new',
      portableSpec: { desiredConfig: { image: 'new' } },
      imageReference: 'new',
      running: true,
    };
    expect(
      subject.operationResourceOverride(
        {
          requestedPolicy: {
            resourceOverride: {
              specFingerprint: 'old',
              portableSpec: { desiredConfig: { image: 'old' } },
              imageReference: 'old',
            },
          },
        },
        fallback
      )
    ).toMatchObject({
      resourceId: 'deployment-1',
      currentNodeId: 'node-1',
      specFingerprint: 'old',
      imageReference: 'old',
    });
  });

  it('does not treat the standalone container placement as an external drift source', () => {
    expect(shouldReconcileAvailabilityResourceDrift('container')).toBe(false);
    expect(shouldReconcileAvailabilityResourceDrift('deployment')).toBe(false);
    expect(shouldReconcileAvailabilityResourceDrift('compose')).toBe(false);
  });

  it('rejects stale daemon acknowledgements before placement state can advance', async () => {
    const subject = service();
    subject.db = { update: vi.fn() };
    await expect(
      subject.persistPlacementResult(
        'placement-1',
        { id: 'operation-1', targetGeneration: 4 },
        { imageReference: 'registry/app@sha256:abc' },
        {
          acknowledgedGeneration: 3,
          actualState: 'serving',
          serving: true,
          dependencyState: 'ready',
          applicationHealth: 'healthy',
        }
      )
    ).rejects.toMatchObject({ code: 'AVAILABILITY_STALE_ACKNOWLEDGEMENT' });
    expect(subject.db.update).not.toHaveBeenCalled();
  });

  it.each([
    'container',
    'deployment',
    'compose',
  ])('completes a %s rollout with existing mismatched fingerprints without backfill', async (kind) => {
    const subject = service();
    const policy = {
      id: 'policy-1',
      mode: 'replicated',
      desiredReplicaCount: 2,
      specFingerprint: 'canonical-policy-fingerprint',
      rolloutPolicy: { maxUnavailable: 1, maxSurge: 0, drainSeconds: 0 },
    };
    const operation = {
      id: 'operation-1',
      type: 'rollout',
      targetGeneration: 2,
      idempotencyKey: 'rollout-2',
      requestedPolicy: {},
    };
    const resource = {
      kind,
      currentNodeId: 'node-1',
      specFingerprint: 'artifact-prepared-fingerprint',
      imageReference: 'registry/app@sha256:new',
      composeRevisionId: 'revision-2',
      running: true,
    };
    const placements = [1, 2].map((index) => ({
      id: `placement-${index}`,
      policyId: policy.id,
      nodeId: `node-${index}`,
      // Cover both an ordinary prior-generation update and a retry whose
      // generation already advanced but whose fingerprint stayed stale.
      generation: index,
      specFingerprint: `old-node-${index}-fingerprint`,
      actualState: 'serving',
      desiredState: 'serving',
      serving: true,
    }));
    const queryValues = (condition: any): unknown[] =>
      (condition?.queryChunks ?? []).flatMap((chunk: any) =>
        chunk?.queryChunks ? queryValues(chunk) : chunk?.value !== undefined ? [chunk.value] : []
      );
    const writes: Array<{ table: unknown; patch: Record<string, unknown> }> = [];
    subject.db = {
      select: () => ({
        from: () => ({
          where: () => {
            const rows = placements.map((placement) => ({ ...placement }));
            return Object.assign(Promise.resolve(rows), { orderBy: async () => rows });
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (patch: Record<string, unknown>) => ({
          where: async (condition: unknown) => {
            writes.push({ table, patch });
            if (table === dockerAvailabilityPlacements) {
              const placement = placements.find(({ id }) => queryValues(condition).includes(id));
              expect(placement).toBeDefined();
              Object.assign(placement!, patch);
            }
          },
        }),
      }),
    };
    subject.nodeRegistry = { getNode: vi.fn((id) => ({ id })) };
    subject.requireActiveLeaseOwner = vi.fn().mockReturnValue('lease');
    subject.updateOperationPhase = vi.fn();
    subject.createPlacement = vi.fn();
    subject.removePlacement = vi.fn();
    subject.queueRolloutRollback = vi.fn();
    subject.publishPolicy = vi.fn();
    const adapter = {
      ensurePlacement: vi.fn(async (context) => ({
        acknowledgedGeneration: context.generation,
        actualState: 'serving',
        serving: true,
        dependencyState: 'ready',
        applicationHealth: 'healthy',
        runtimeIdentity: { containerId: `new-${context.nodeId}` },
      })),
    };

    await expect(
      subject.executeRollout(operation, policy, resource, adapter, [{ id: 'node-1' }, { id: 'node-2' }], false)
    ).resolves.toBeUndefined();
    expect(adapter.ensurePlacement).toHaveBeenCalledTimes(2);
    expect(
      placements.every(
        (placement) =>
          placement.generation === 2 && placement.specFingerprint === resource.specFingerprint && placement.serving
      )
    ).toBe(true);
    expect(subject.createPlacement).not.toHaveBeenCalled();
    expect(subject.removePlacement).not.toHaveBeenCalled();
    expect(subject.queueRolloutRollback).not.toHaveBeenCalled();
    expect(writes).toContainEqual({
      table: dockerAvailabilityPolicies,
      patch: expect.objectContaining({ status: 'healthy' }),
    });

    // Re-running the same acknowledged rollout must not reapply either runtime.
    adapter.ensurePlacement.mockClear();
    await subject.executeRollout(operation, policy, resource, adapter, [{ id: 'node-1' }, { id: 'node-2' }], false);
    expect(adapter.ensurePlacement).not.toHaveBeenCalled();
  });

  it('does not mark deferred configuration applied when persisting a stopped runtime', async () => {
    const subject = service();
    const set = vi.fn((_patch: Record<string, unknown>) => ({ where: vi.fn() }));
    subject.db = { update: () => ({ set }) };
    await subject.persistPlacementResult(
      'placement-1',
      { id: 'stop', targetGeneration: 2 },
      { specFingerprint: 'pending-new-spec', imageReference: 'new-image' },
      {
        acknowledgedGeneration: 2,
        actualState: 'stopped',
        serving: false,
        dependencyState: 'ready',
        applicationHealth: 'unknown',
        runtimeIdentity: { containerId: 'existing-id' },
      }
    );
    expect(set.mock.calls[0]![0]).not.toHaveProperty('specFingerprint');
  });

  it('does not resolve node-local runtime fingerprints during HA drift reconciliation', async () => {
    const subject = service();
    subject.db = {
      select: () => ({
        from: () => ({
          where: async () =>
            ['container', 'deployment', 'compose'].map((resourceKind) => ({
              id: resourceKind,
              resourceKind,
              mode: 'replicated',
              specFingerprint: 'canonical-spec',
            })),
        }),
      }),
      update: vi.fn(),
    };
    const resolve = vi.fn().mockResolvedValue({ specFingerprint: 'node-local-spec' });
    subject.requireAdapter = vi.fn().mockReturnValue({ resolve });
    await subject.reconcileResourceDrift();
    expect(resolve).not.toHaveBeenCalled();
    expect(subject.db.update).not.toHaveBeenCalled();
  });

  it('replaces a retired placement row so the daemon receives a fresh placement identity', async () => {
    const subject = service();
    const selectLimit = vi.fn().mockResolvedValue([{ id: 'retired-placement', actualState: 'removed' }]);
    const selectWhere = vi.fn(() => ({ limit: selectLimit }));
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteRow = vi.fn(() => ({ where: deleteWhere }));
    const returning = vi.fn().mockResolvedValue([{ id: 'fresh-placement' }]);
    const onConflictDoUpdate = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    subject.db = { select: vi.fn(() => ({ from: selectFrom })), delete: deleteRow, insert };

    await expect(
      subject.createPlacement(
        { id: 'policy-1' },
        { id: 'operation-1', targetGeneration: 6 },
        { specFingerprint: 'fingerprint', imageReference: 'image', composeRevisionId: null },
        'node-1'
      )
    ).resolves.toMatchObject({ id: 'fresh-placement' });
    expect(deleteRow).toHaveBeenCalledWith(expect.anything());
    expect(deleteWhere).toHaveBeenCalledOnce();
  });

  it('retries dependency cleanup for an already removed placement', async () => {
    const subject = service();
    const placement = {
      id: 'placement-1',
      policyId: 'policy-1',
      nodeId: 'node-1',
      actualState: 'removed',
    };
    const limit = vi.fn().mockResolvedValue([placement]);
    let selectCalls = 0;
    const where = vi.fn(() => {
      selectCalls += 1;
      return selectCalls === 1
        ? { limit }
        : selectCalls === 2
          ? { limit: vi.fn().mockResolvedValue([]) }
          : Promise.resolve([placement]);
    });
    const from = vi.fn(() => ({ where }));
    subject.db = {
      select: vi.fn(() => ({ from })),
      update: vi.fn(() => ({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) })),
    };
    subject.requirePolicy = vi.fn().mockResolvedValue({
      id: 'policy-1',
      resourceKind: 'container',
      mode: 'single',
      desiredReplicaCount: 1,
      desiredGeneration: 7,
      shouldRun: true,
    });
    subject.resolvePolicyResource = vi.fn().mockResolvedValue({ kind: 'container' });
    const adapter = { removePlacement: vi.fn().mockResolvedValue(undefined) };
    subject.requireAdapter = vi.fn().mockReturnValue(adapter);
    subject.nodeRegistry = { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) };
    subject.requireActiveLeaseOwner = vi.fn().mockReturnValue('lease-1');

    await subject.executeStaleCleanup({
      id: 'operation-1',
      policyId: 'policy-1',
      targetGeneration: 7,
      idempotencyKey: 'cleanup-key',
      requestedPolicy: { placementId: 'placement-1' },
    });

    expect(adapter.removePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ placementId: 'placement-1', nodeId: 'node-1', generation: 7 })
    );
  });

  it('clears a stale degraded policy after the last cleanup converges', async () => {
    const subject = service();
    const updates: Array<Record<string, unknown>> = [];
    subject.db = {
      select: vi.fn(() => ({
        from: () => ({
          where: async () => [
            {
              id: 'survivor',
              nodeId: 'node-1',
              generation: 7,
              desiredState: 'serving',
              actualState: 'serving',
              serving: true,
            },
            {
              id: 'retired',
              nodeId: 'node-2',
              generation: 7,
              desiredState: 'removed',
              actualState: 'removed',
              serving: false,
            },
          ],
        }),
      })),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            updates.push(values);
          },
        }),
      })),
    };
    subject.db.select.mockImplementationOnce(() => ({
      from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([]) }) }),
    }));
    subject.nodeRegistry = { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) };
    subject.queueHealIfNeeded = vi.fn();

    await subject.refreshPolicyAfterStaleCleanup({
      id: 'policy-1',
      mode: 'single',
      desiredReplicaCount: 1,
      desiredGeneration: 7,
      shouldRun: true,
    });

    expect(updates).toContainEqual(
      expect.objectContaining({ status: 'healthy', lastErrorCode: null, lastErrorMessage: null })
    );
    expect(subject.queueHealIfNeeded).not.toHaveBeenCalled();
  });

  it('never lets background stale cleanup remove a serving placement from the previous generation', async () => {
    const subject = service();
    const placement = {
      id: 'placement-1',
      policyId: 'policy-1',
      nodeId: 'node-1',
      generation: 8,
      desiredState: 'serving',
      actualState: 'serving',
      serving: true,
    };
    const limit = vi.fn().mockResolvedValue([placement]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const update = vi.fn();
    subject.db = { select: vi.fn(() => ({ from })), update };
    subject.requirePolicy = vi.fn().mockResolvedValue({
      id: 'policy-1',
      resourceKind: 'container',
      desiredGeneration: 9,
    });
    subject.resolvePolicyResource = vi.fn().mockResolvedValue({ kind: 'container' });
    const adapter = { removePlacement: vi.fn() };
    subject.requireAdapter = vi.fn().mockReturnValue(adapter);
    subject.nodeRegistry = { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) };
    subject.requireActiveLeaseOwner = vi.fn().mockReturnValue('lease-1');
    subject.queueHealIfNeeded = vi.fn().mockResolvedValue(undefined);

    await subject.executeStaleCleanup({
      id: 'operation-1',
      policyId: 'policy-1',
      targetGeneration: 9,
      idempotencyKey: 'cleanup-key',
      requestedPolicy: { placementId: 'placement-1' },
    });

    expect(subject.queueHealIfNeeded).toHaveBeenCalledWith('policy-1');
    expect(adapter.removePlacement).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('defers failed placement cleanup without failing the serving reconcile', async () => {
    const subject = service();
    subject.updateOperationPhase = vi.fn().mockResolvedValue(undefined);
    const updates: Array<Record<string, unknown>> = [];
    subject.db = {
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            updates.push(values);
          },
        }),
      })),
    };
    subject.nodeRegistry = { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) };
    subject.requireActiveLeaseOwner = vi.fn().mockReturnValue('lease-1');
    subject.queueOperation = vi.fn().mockResolvedValue(undefined);
    const adapter = {
      drainPlacement: vi.fn().mockResolvedValue(undefined),
      removePlacement: vi.fn().mockRejectedValue(new Error('network has active endpoints')),
    };

    await subject.removePlacement(
      adapter,
      { kind: 'container' },
      { id: 'policy-1', desiredGeneration: 9 },
      { id: 'operation-1', idempotencyKey: 'heal-9' },
      { id: 'placement-1', nodeId: 'node-1' },
      0
    );

    expect(updates).toEqual([
      expect.objectContaining({ actualState: 'draining', serving: false }),
      expect.objectContaining({ actualState: 'cleanup_pending', desiredState: 'removed', serving: false }),
    ]);
    expect(subject.queueOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        policyId: 'policy-1',
        type: 'stale_cleanup',
        requestedPolicy: { placementId: 'placement-1' },
      })
    );
  });

  it('does not report healthy when stale cleanup finishes during an active rollout', async () => {
    const subject = service();
    subject.db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: vi.fn().mockResolvedValue([{ id: 'active-rollout' }]),
          }),
        }),
      })),
      update: vi.fn(),
    };
    await subject.refreshPolicyAfterStaleCleanup({ id: 'policy-1' });
    expect(subject.db.update).not.toHaveBeenCalled();
  });

  it('checks whether healing is still needed after a node reconnects', async () => {
    const subject = service();
    const placementsWhere = vi.fn().mockResolvedValue([
      {
        id: 'placement-1',
        policyId: 'policy-1',
        nodeId: 'node-1',
        generation: 3,
        desiredState: 'serving',
        actualState: 'unreachable',
      },
    ]);
    const policiesWhere = vi.fn().mockResolvedValue([{ id: 'policy-1' }]);
    subject.db = {
      select: vi
        .fn()
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: placementsWhere })) })
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: policiesWhere })) }),
    };
    subject.requirePolicy = vi.fn().mockResolvedValue({ id: 'policy-1', mode: 'failover', desiredGeneration: 4 });
    subject.queueOperation = vi.fn().mockResolvedValue(undefined);
    subject.queueHealIfNeeded = vi.fn().mockResolvedValue(undefined);
    subject.publishPolicy = vi.fn();
    subject.kick = vi.fn();

    await subject.handleNodeOnline('node-1');

    expect(subject.queueHealIfNeeded).toHaveBeenCalledWith('policy-1');
    expect(subject.queueOperation).not.toHaveBeenCalled();
    expect(subject.kick).toHaveBeenCalledOnce();
  });

  it('keeps the failover ingress member active until replacement grace expires', async () => {
    vi.useFakeTimers();
    try {
      const subject = service();
      const affected = [
        {
          id: 'placement-1',
          policyId: 'policy-1',
          nodeId: 'node-1',
          generation: 3,
        },
      ];
      subject.db = {
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue(affected) })),
          })),
        })),
      };
      subject.requirePolicy = vi.fn().mockResolvedValue({
        id: 'policy-1',
        mode: 'failover',
        resourceKind: 'compose',
        offlineReplacementGraceSeconds: 15,
      });
      subject.resolvePolicyResource = vi.fn().mockResolvedValue({ kind: 'compose' });
      const deactivatePlacementDependencies = vi.fn().mockResolvedValue(undefined);
      subject.requireAdapter = vi.fn().mockReturnValue({ deactivatePlacementDependencies });
      subject.queueHealIfNeeded = vi.fn().mockResolvedValue(undefined);
      subject.publishPolicy = vi.fn();
      subject.kick = vi.fn();

      await subject.handleNodeUnavailable('node-1');

      expect(deactivatePlacementDependencies).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(deactivatePlacementDependencies).toHaveBeenCalledOnce();
      expect(subject.queueHealIfNeeded).toHaveBeenCalledWith('policy-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks enabled policies after a node reconnects even when their old placement row is gone', async () => {
    const subject = service();
    const placementsWhere = vi.fn().mockResolvedValue([]);
    const policiesWhere = vi.fn().mockResolvedValue([{ id: 'policy-1' }]);
    subject.db = {
      select: vi
        .fn()
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: placementsWhere })) })
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: policiesWhere })) }),
    };
    subject.queueHealIfNeeded = vi.fn().mockResolvedValue(undefined);
    subject.publishPolicy = vi.fn();
    subject.kick = vi.fn();

    await subject.handleNodeOnline('node-1');

    expect(subject.publishPolicy).toHaveBeenCalledWith('policy-1', 'node_reconnected', 'node-1');
    expect(subject.queueHealIfNeeded).toHaveBeenCalledWith('policy-1');
    expect(subject.kick).toHaveBeenCalledOnce();
  });

  it('does not queue a second heal while one is already active', async () => {
    const subject = service();
    subject.requirePolicy = vi.fn().mockResolvedValue({
      id: 'policy-1',
      mode: 'failover',
      desiredGeneration: 5,
    });
    const placementsWhere = vi.fn().mockResolvedValue([]);
    const activeHealLimit = vi.fn().mockResolvedValue([{ id: 'heal-1' }]);
    subject.db = {
      select: vi
        .fn()
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: placementsWhere })) })
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: activeHealLimit })) })),
        }),
    };
    subject.queueOperation = vi.fn();
    subject.licensePolicy = { hasFeature: vi.fn() };

    await subject.queueHealIfNeeded('policy-1');

    expect(subject.queueOperation).not.toHaveBeenCalled();
    expect(subject.licensePolicy.hasFeature).not.toHaveBeenCalled();
  });

  it('does not heal an intentionally stopped workload', async () => {
    const subject = service();
    subject.requirePolicy = vi.fn().mockResolvedValue({
      id: 'policy-1',
      mode: 'replicated',
      shouldRun: false,
      desiredGeneration: 5,
    });
    subject.db = { select: vi.fn() };
    subject.queueOperation = vi.fn();
    subject.licensePolicy = { hasFeature: vi.fn() };

    await subject.queueHealIfNeeded('policy-1');

    expect(subject.db.select).not.toHaveBeenCalled();
    expect(subject.queueOperation).not.toHaveBeenCalled();
    expect(subject.licensePolicy.hasFeature).not.toHaveBeenCalled();
  });

  it('clears a stale degraded status when current serving placements already satisfy the policy', async () => {
    const subject = service();
    subject.requirePolicy = vi.fn().mockResolvedValue({
      id: 'policy-1',
      mode: 'replicated',
      shouldRun: true,
      desiredReplicaCount: 2,
      desiredGeneration: 5,
      status: 'degraded',
      lastErrorCode: 'AVAILABILITY_OPERATION_FAILED',
      lastErrorMessage: 'temporary node disconnect',
    });
    const updateWhere = vi.fn().mockResolvedValue([]);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    subject.db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([
            { nodeId: 'node-1', generation: 5, desiredState: 'serving', actualState: 'serving', serving: true },
            { nodeId: 'node-2', generation: 5, desiredState: 'serving', actualState: 'serving', serving: true },
          ]),
        })),
      })),
      update: vi.fn(() => ({ set: updateSet })),
    };
    subject.nodeRegistry = { getNode: vi.fn().mockReturnValue({ id: 'online' }) };
    subject.publishPolicy = vi.fn();
    subject.queueOperation = vi.fn();

    await subject.queueHealIfNeeded('policy-1');

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'healthy', lastErrorCode: null, lastErrorMessage: null })
    );
    expect(subject.publishPolicy).toHaveBeenCalledWith('policy-1', 'healthy');
    expect(subject.queueOperation).not.toHaveBeenCalled();
  });

  it('uses the outage epoch when healing the same replicated generation again', async () => {
    const subject = service();
    const outage = new Date('2026-09-03T04:00:00.000Z');
    subject.requirePolicy = vi.fn().mockResolvedValue({
      id: 'policy-1',
      mode: 'replicated',
      shouldRun: true,
      desiredReplicaCount: 2,
      desiredGeneration: 5,
    });
    const placementsWhere = vi.fn().mockResolvedValue([
      {
        serving: false,
        actualState: 'unreachable',
        unavailableSince: outage,
        updatedAt: outage,
        nodeId: 'node-1',
      },
    ]);
    const activeHealLimit = vi.fn().mockResolvedValue([]);
    subject.db = {
      select: vi
        .fn()
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: placementsWhere })) })
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: activeHealLimit })) })),
        }),
    };
    subject.nodeRegistry = { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) };
    subject.licensePolicy = { hasFeature: vi.fn().mockResolvedValue(true) };
    subject.queueOperation = vi.fn().mockResolvedValue(undefined);

    await subject.queueHealIfNeeded('policy-1');

    expect(subject.queueOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        policyId: 'policy-1',
        targetGeneration: 5,
        idempotencyKey: `availability:heal:policy-1:5:0:${outage.getTime()}`,
      })
    );
  });

  it('recovers a reconnected failover placement in the current generation', async () => {
    const subject = service();
    const outage = new Date('2026-09-03T05:00:00.000Z');
    subject.requirePolicy = vi.fn().mockResolvedValue({
      id: 'policy-1',
      mode: 'failover',
      shouldRun: true,
      desiredGeneration: 7,
    });
    const placementsWhere = vi.fn().mockResolvedValue([
      {
        serving: false,
        desiredState: 'serving',
        actualState: 'unreachable',
        unavailableSince: outage,
        updatedAt: outage,
        nodeId: 'node-1',
      },
    ]);
    const activeHealLimit = vi.fn().mockResolvedValue([]);
    const update = vi.fn();
    subject.db = {
      select: vi
        .fn()
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: placementsWhere })) })
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: activeHealLimit })) })),
        }),
      update,
    };
    subject.nodeRegistry = { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) };
    subject.licensePolicy = { hasFeature: vi.fn().mockResolvedValue(true) };
    subject.queueOperation = vi.fn().mockResolvedValue(undefined);

    await subject.queueHealIfNeeded('policy-1');

    expect(update).not.toHaveBeenCalled();
    expect(subject.queueOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        policyId: 'policy-1',
        targetGeneration: 7,
        idempotencyKey: `availability:heal:policy-1:7:0:${outage.getTime()}`,
      })
    );
  });

  it('does not advance failover generation or queue healing after entitlement loss', async () => {
    const subject = service();
    subject.requirePolicy = vi.fn().mockResolvedValue({
      id: 'policy-1',
      mode: 'failover',
      desiredGeneration: 5,
    });
    const placementsWhere = vi.fn().mockResolvedValue([]);
    const activeHealLimit = vi.fn().mockResolvedValue([]);
    const update = vi.fn();
    subject.db = {
      select: vi
        .fn()
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: placementsWhere })) })
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: activeHealLimit })) })),
        }),
      update,
    };
    subject.licensePolicy = { hasFeature: vi.fn().mockResolvedValue(false) };
    subject.refreshPolicyStatus = vi.fn().mockResolvedValue(undefined);
    subject.queueOperation = vi.fn();

    await subject.queueHealIfNeeded('policy-1');

    expect(update).not.toHaveBeenCalled();
    expect(subject.queueOperation).not.toHaveBeenCalled();
    expect(subject.refreshPolicyStatus).toHaveBeenCalledWith(
      'policy-1',
      'AVAILABILITY_ENTITLEMENT_REQUIRED_FOR_HEALING',
      expect.any(String)
    );
  });

  it('revalidates the disable survivor immediately before adoption', async () => {
    const subject = service();
    subject.requirePolicy = vi.fn().mockResolvedValue({
      id: 'policy-1',
      resourceKind: 'container',
      desiredGeneration: 6,
    });
    subject.resolvePolicyResource = vi.fn().mockResolvedValue({ kind: 'container' });
    const adapter = { adoptPlacementAsSingle: vi.fn() };
    subject.requireAdapter = vi.fn().mockReturnValue(adapter);
    subject.db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([
            {
              id: 'placement-1',
              nodeId: 'node-1',
              generation: 5,
              actualState: 'unreachable',
              serving: false,
              dependencyState: 'ready',
              applicationHealth: 'healthy',
            },
          ]),
        })),
      })),
    };
    subject.nodeRegistry = { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) };

    await expect(
      subject.executeDisable({
        id: 'operation-1',
        policyId: 'policy-1',
        targetGeneration: 6,
        requestedPolicy: { survivingPlacementId: 'placement-1' },
      })
    ).rejects.toMatchObject({ code: 'AVAILABILITY_SURVIVOR_INVALID' });
    expect(adapter.adoptPlacementAsSingle).not.toHaveBeenCalled();
  });

  it('falls back to the best current healthy survivor when retrying a partially completed disable', async () => {
    const subject = service();
    subject.requirePolicy = vi.fn().mockResolvedValue({
      id: 'policy-1',
      resourceKind: 'compose',
      desiredGeneration: 6,
      shouldRun: true,
      rolloutPolicy: { drainSeconds: 0 },
    });
    subject.resolvePolicyResource = vi.fn().mockResolvedValue({
      kind: 'compose',
      currentNodeId: 'node-2',
      reference: { type: 'compose', composeProjectId: 'project-1' },
    });
    const adapter = {
      resolve: vi.fn().mockResolvedValue({ kind: 'compose', portableSpec: { yaml: 'services: {}' } }),
      adoptPlacementAsSingle: vi.fn(),
      finalizePlacementAsSingle: vi.fn(),
      removePlacement: vi.fn(),
    };
    subject.requireAdapter = vi.fn().mockReturnValue(adapter);
    subject.disableSurvivorResource = vi.fn().mockReturnValue({ kind: 'container' });
    subject.requireActiveLeaseOwner = vi.fn().mockReturnValue('lease-owner');
    subject.updateOperationPhase = vi.fn();
    subject.removePlacement = vi.fn();
    subject.publishPolicy = vi.fn();
    subject.artifacts = { cleanup: vi.fn() };
    const placements = [
      {
        id: 'placement-old',
        nodeId: 'node-1',
        generation: 5,
        actualState: 'serving',
        serving: true,
        dependencyState: 'ready',
        applicationHealth: 'healthy',
      },
      {
        id: 'placement-current',
        nodeId: 'node-2',
        generation: 6,
        actualState: 'serving',
        serving: true,
        dependencyState: 'ready',
        applicationHealth: 'healthy',
      },
    ];
    const tx = {
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
    };
    subject.db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(placements) })) })),
      update: tx.update,
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    subject.lockPolicy = vi.fn();
    subject.completeOperation = vi.fn();
    subject.nodeRegistry = { getNode: vi.fn().mockReturnValue({ id: 'connected' }) };

    await subject.executeDisable({
      id: 'operation-1',
      policyId: 'policy-1',
      targetGeneration: 6,
      idempotencyKey: 'disable-1',
      retryAttempts: 1,
      requestedPolicy: { survivingPlacementId: 'placement-old' },
    });

    expect(adapter.adoptPlacementAsSingle).toHaveBeenCalledWith(
      expect.objectContaining({ placementId: 'placement-current', nodeId: 'node-2' })
    );
    expect(adapter.resolve).toHaveBeenCalledWith({ type: 'compose', composeProjectId: 'project-1' });
    expect(subject.disableSurvivorResource).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'compose' }),
      expect.objectContaining({ id: 'placement-current' }),
      expect.objectContaining({ portableSpec: { yaml: 'services: {}' } })
    );
  });

  it('allows a reachable stopped placement to survive disablement for a stopped workload', () => {
    const subject = service();
    subject.nodeRegistry = { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) };

    expect(
      subject.disableSurvivorIsValid(
        { shouldRun: false },
        {
          nodeId: 'node-1',
          actualState: 'stopped',
          serving: false,
          dependencyState: 'ready',
          applicationHealth: 'unknown',
        }
      )
    ).toBe(true);
    expect(
      subject.disableSurvivorIsValid(
        { shouldRun: false },
        {
          nodeId: 'node-1',
          actualState: 'removed',
          serving: false,
          dependencyState: 'ready',
          applicationHealth: 'unknown',
        }
      )
    ).toBe(true);
  });

  it('validates disable adoption against the survivor immutable artifact fingerprint', () => {
    const subject = service();
    expect(
      subject.disableSurvivorResource(
        {
          kind: 'container',
          specFingerprint: 'source-fingerprint',
          imageReference: 'example/api:latest',
          sourceImageReference: 'example/api:latest',
        },
        {
          specFingerprint: 'placement-fingerprint',
          imageReference: `127.0.0.1:5443/gateway/availability/p/1/7@sha256:${'a'.repeat(64)}`,
        }
      )
    ).toMatchObject({
      specFingerprint: 'placement-fingerprint',
      imageReference: expect.stringContaining('@sha256:'),
      sourceImageReference: 'example/api:latest',
    });
  });

  it('uses the canonical Compose spec while retaining the survivor runtime fingerprint', () => {
    const subject = service();
    expect(
      subject.disableSurvivorResource(
        {
          kind: 'compose',
          portableSpec: { yaml: 'services:\n  web:\n    image: internal:image\n' },
          specFingerprint: 'policy-fingerprint',
        },
        { specFingerprint: 'survivor-fingerprint', imageReference: null },
        {
          kind: 'compose',
          portableSpec: { yaml: 'services:\n  web:\n    image: nginx:alpine\n' },
        }
      )
    ).toMatchObject({
      portableSpec: { yaml: 'services:\n  web:\n    image: nginx:alpine\n' },
      specFingerprint: 'survivor-fingerprint',
    });
  });

  it('stops every reachable placement without preparing or starting images', async () => {
    const subject = service();
    const placement = {
      id: 'placement-1',
      nodeId: 'node-1',
      actualState: 'serving',
      serving: true,
    };
    const stoppedPlacement = { ...placement, actualState: 'stopped', serving: false };
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    subject.db = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({ orderBy: vi.fn().mockResolvedValue([placement]) })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([stoppedPlacement]) })),
        }),
      update: vi.fn(() => ({ set: updateSet })),
    };
    subject.updateOperationPhase = vi.fn().mockResolvedValue(undefined);
    subject.nodeRegistry = { getNode: vi.fn().mockReturnValue({ id: 'node-1' }) };
    subject.requireActiveLeaseOwner = vi.fn().mockReturnValue('lease-1');
    subject.persistPlacementResult = vi.fn().mockResolvedValue(undefined);
    subject.publishPolicy = vi.fn();
    const adapter = {
      stopPlacement: vi.fn().mockResolvedValue({
        acknowledgedGeneration: 3,
        actualState: 'stopped',
        serving: false,
        dependencyState: 'ready',
        applicationHealth: 'unknown',
      }),
    };

    await subject.executeStoppedReconcile(
      { id: 'operation-1', targetGeneration: 3, idempotencyKey: 'stop-3' },
      { id: 'policy-1' },
      { kind: 'container', running: false },
      adapter
    );

    expect(subject.updateOperationPhase).toHaveBeenCalledWith('operation-1', 'stopping');
    expect(adapter.stopPlacement).toHaveBeenCalledWith(
      expect.objectContaining({ placementId: 'placement-1', generation: 3, leaseOwner: 'lease-1' })
    );
    expect(subject.persistPlacementResult).toHaveBeenCalledOnce();
    expect(subject.publishPolicy).toHaveBeenCalledWith('policy-1', 'stopped');
  });

  it('requeues every in-process operation on control-plane restart regardless of its old lease expiry', async () => {
    const subject = service();
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    subject.db = { update };
    subject.kick = vi.fn();

    await subject.recoverInterruptedOperations();

    expect(update).toHaveBeenCalledWith(expect.anything());
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        leaseOwner: null,
        leaseHeartbeatAt: null,
        leaseExpiresAt: null,
      })
    );
    expect(where).toHaveBeenCalledOnce();
    expect(subject.kick).toHaveBeenCalledOnce();
  });

  it('blocks direct mutation of the original standalone container placement', async () => {
    const subject = service();
    const limit = vi.fn().mockResolvedValue([{ id: 'placement-1' }]);
    const where = vi.fn(() => ({ limit }));
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    subject.db = { select: vi.fn(() => ({ from })) };

    await expect(subject.assertContainerMutationAllowed('node-1', 'api')).rejects.toMatchObject({
      code: 'AVAILABILITY_PLACEMENT_MANAGED',
    });
  });

  it('loads an existing policy from its stored snapshot without inspecting an offline origin', async () => {
    const subject = service();
    const policy = { id: 'policy-1' };
    const resource = { viewScope: 'docker:containers:view' };
    subject.findPolicyByResourceReference = vi.fn().mockResolvedValue(policy);
    subject.resolvePolicyResource = vi.fn().mockResolvedValue(resource);
    subject.assertResourceAccess = vi.fn();
    subject.policyView = vi.fn().mockResolvedValue({ id: 'policy-1', status: 'degraded' });
    subject.requireAdapter = vi.fn();

    await expect(
      subject.getByResource({ type: 'container', nodeId: 'offline-node', containerName: 'api' }, [])
    ).resolves.toMatchObject({ id: 'policy-1', status: 'degraded' });
    expect(subject.requireAdapter).not.toHaveBeenCalled();
    expect(subject.resolvePolicyResource).toHaveBeenCalledWith(policy);
  });

  it('maps managed database binding targets back to the active logical Availability policy', async () => {
    const subject = service();
    subject.findPolicyByResourceReference = vi.fn().mockResolvedValue({ id: 'policy-1', mode: 'replicated' });

    await expect(
      subject.resolveManagedDatabaseBindingPolicyId({
        targetNodeId: 'node-1',
        targetType: 'compose_service',
        targetResourceId: 'compose-1:api',
      })
    ).resolves.toBe('policy-1');
    expect(subject.findPolicyByResourceReference).toHaveBeenCalledWith({
      type: 'compose',
      composeProjectId: 'compose-1',
    });
  });

  it('queues a new generation for a managed database dependency rollout', async () => {
    const subject = service();
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const tx = { update };
    subject.db = { transaction: (callback: (writer: typeof tx) => Promise<unknown>) => callback(tx) };
    subject.licensePolicy = { requireFeature: vi.fn().mockResolvedValue(undefined) };
    subject.lockPolicy = vi.fn().mockResolvedValue(undefined);
    subject.supersedeQueuedOperations = vi.fn().mockResolvedValue(undefined);
    subject.requirePolicy = vi.fn().mockResolvedValue({ id: 'policy-1', mode: 'replicated', desiredGeneration: 4 });
    subject.insertOperation = vi.fn().mockResolvedValue({ id: 'operation-1' });
    subject.publishPolicy = vi.fn();
    subject.kick = vi.fn();

    await subject.queueDependencyRollout('policy-1', 'user-1');

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ desiredGeneration: 5, status: 'rolling_out', updatedById: 'user-1' })
    );
    expect(subject.insertOperation).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        policyId: 'policy-1',
        type: 'rollout',
        targetGeneration: 5,
        requestedPolicy: { dependencyRefresh: 'managed_database_binding' },
      })
    );
    expect(subject.publishPolicy).toHaveBeenCalledWith('policy-1', 'database_dependency_rollout_queued');
    expect(subject.kick).toHaveBeenCalledOnce();
  });

  it('queues a deployment slot switch as one logical Availability rollout', async () => {
    const subject = service();
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    subject.db = {
      transaction: vi.fn(async (callback: (tx: { update: typeof update }) => Promise<void>) => callback({ update })),
    };
    subject.findPolicyByResourceReference = vi.fn().mockResolvedValue({
      id: 'policy-1',
      mode: 'replicated',
      portableSpec: { activeSlot: 'blue', desiredConfig: { image: 'app:v1' } },
      imageReference: 'app:v1',
      shouldRun: true,
    });
    subject.licensePolicy = { requireFeature: vi.fn().mockResolvedValue(undefined) };
    subject.queueCanonicalRollout = vi.fn().mockResolvedValue('operation-1');
    subject.waitForOperationCompletion = vi.fn().mockResolvedValue(undefined);

    await expect(subject.switchDeploymentSlot('deployment-1', 'green', 'user-1')).resolves.toBe(true);

    expect(subject.queueCanonicalRollout).toHaveBeenCalledWith(
      'policy-1',
      expect.objectContaining({ portableSpec: expect.objectContaining({ activeSlot: 'green' }) }),
      'user-1',
      'deployment_slot_switch',
      { targetActiveSlot: 'green' }
    );
    expect(subject.waitForOperationCompletion).toHaveBeenCalledWith('operation-1');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ activeSlot: 'green', status: 'ready' }));
  });
});
