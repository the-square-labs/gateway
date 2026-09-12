import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayPolicyState } from '@/db/schema/index.js';
import { RelayPoolService, relayPoolInternals } from './relay-pool.service.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function service(db: any = {}) {
  const policy = {
    syncSnapshot: vi.fn().mockResolvedValue(undefined),
    reconcileAndSync: vi.fn().mockResolvedValue(undefined),
    syncRemoteInstancePolicy: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const events = { publish: vi.fn() };
  const settings = { getConfig: vi.fn().mockResolvedValue({ relay: { assignmentSpread: { mode: 'all' } } }) };
  return {
    pool: new RelayPoolService(db, policy as any, events as any, audit as any, settings as any),
    policy,
    audit,
    events,
  };
}

// A queued query boundary exercises orchestration without a running production DB.
function queuedDb(rows: unknown[][]) {
  const conditions: any[] = [];
  function result(value: unknown[]) {
    const query: any = Promise.resolve(value);
    for (const method of ['from', 'where', 'orderBy', 'limit', 'innerJoin']) query[method] = () => query;
    query.where = (condition: any) => {
      conditions.push(condition);
      return query;
    };
    return query;
  }
  const writes: any[] = [];
  const db: any = {
    select: vi.fn(() => {
      if (!rows.length) throw new Error('Unexpected query');
      return result(rows.shift()!);
    }),
    execute: vi.fn().mockResolvedValue(undefined),
    update: vi.fn((table) => ({
      set: (values: any) => ({
        where: (where: any) => {
          writes.push({ table, values, where });
          const result: any = Promise.resolve([]);
          result.returning = () => Promise.resolve(db.updateResult ?? [{ id: 'new' }]);
          return result;
        },
      }),
    })),
  };
  db.selectDistinctOn = db.select;
  db.selectDistinct = db.select;
  db.transaction = vi.fn((callback) => callback(db));
  return { db, writes, conditions };
}

function reconciliationHarness() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
  const { pool } = service();
  const snapshot: any = {
    rebalanceAvailable: true,
    rebalanceEndpointIds: ['endpoint'],
    rebalancePlanKey: 'plan-a',
    blockers: [],
    failures: [],
    staging: [],
    automaticRebalancePaused: false,
  };
  vi.spyOn(pool, 'retireDrainedGenerations').mockResolvedValue(0);
  vi.spyOn(pool, 'getSnapshot').mockImplementation(async () => snapshot);
  const stage = vi.spyOn(pool, 'stageRebalance').mockResolvedValue([]);
  return { pool, snapshot, stage };
}

describe('RelayPoolService automatic reconciliation', () => {
  it('waits for a stable plan and restarts the debounce when assignments change', async () => {
    const { pool, snapshot, stage } = reconciliationHarness();
    await pool.reconcile();
    vi.advanceTimersByTime(25_000);
    snapshot.rebalancePlanKey = 'plan-b';
    await pool.reconcile();
    vi.advanceTimersByTime(25_000);
    await pool.reconcile();
    expect(stage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    await pool.reconcile();
    expect(stage).toHaveBeenCalledExactlyOnceWith(undefined, {
      allowNoop: true,
      automatic: true,
      endpointIds: ['endpoint'],
    });
  });

  it.each(['maintenance', 'capability', 'balanced'])('does not rebalance while %s blocks it', async (condition) => {
    const { pool, snapshot, stage } = reconciliationHarness();
    await pool.reconcile();
    vi.advanceTimersByTime(30_000);
    if (condition === 'maintenance') snapshot.automaticRebalancePaused = true;
    if (condition === 'capability') snapshot.blockers = ['missing pool capability'];
    if (condition === 'balanced') snapshot.rebalanceAvailable = false;
    await pool.reconcile();
    expect(stage).not.toHaveBeenCalled();
  });

  it('uses persisted failures to retain the five-minute retry guard after restart', async () => {
    const { pool, snapshot, stage } = reconciliationHarness();
    snapshot.failures = [{ endpointId: 'endpoint', updatedAt: new Date() }];
    await pool.reconcile();
    vi.advanceTimersByTime(299_999);
    await pool.reconcile();
    expect(stage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await pool.reconcile();
    expect(stage).toHaveBeenCalledOnce();
  });

  it('does not impose a failure cooldown on the next topology change after success', async () => {
    const { pool, snapshot, stage } = reconciliationHarness();
    await pool.reconcile();
    vi.advanceTimersByTime(30_000);
    await pool.reconcile();
    snapshot.rebalancePlanKey = 'plan-b';
    await pool.reconcile();
    vi.advanceTimersByTime(30_000);
    await pool.reconcile();
    expect(stage).toHaveBeenCalledTimes(2);
  });

  it('also throttles failures before generation persistence', async () => {
    const { pool, stage } = reconciliationHarness();
    stage.mockRejectedValue(new Error('policy unavailable'));
    await pool.reconcile();
    vi.advanceTimersByTime(30_000);
    await expect(pool.reconcile()).rejects.toThrow('policy unavailable');
    vi.advanceTimersByTime(299_999);
    await pool.reconcile();
    expect(stage).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    await expect(pool.reconcile()).rejects.toThrow('policy unavailable');
    expect(stage).toHaveBeenCalledTimes(2);
  });

  it('shares one reconciliation flight across timer ticks', async () => {
    const { pool } = reconciliationHarness();
    let release!: (value: number) => void;
    vi.mocked(pool.retireDrainedGenerations).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const first = pool.reconcile();
    expect(pool.reconcile()).toBe(first);
    expect(pool.retireDrainedGenerations).toHaveBeenCalledOnce();
    release(0);
    await first;
  });

  it('fails interrupted staging instead of replaying old acknowledgements', async () => {
    const { pool, snapshot, stage } = reconciliationHarness();
    snapshot.staging = [{ id: 'abandoned', updatedAt: new Date(Date.now() - 120_000) }];
    const fail = vi.spyOn(pool as any, 'failStaging').mockResolvedValue(undefined);
    const activate = vi.spyOn(pool as any, 'tryActivate');
    await pool.reconcile();
    expect(fail).toHaveBeenCalledWith(
      ['abandoned'],
      expect.objectContaining({ message: expect.stringContaining('interrupted') })
    );
    expect(activate).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });

  it('does not reclaim a manual rebalance that is still running', async () => {
    const { pool } = service();
    let release!: (value: unknown[]) => void;
    vi.spyOn(pool as any, 'stageRebalanceOnce').mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    vi.spyOn(pool, 'retireDrainedGenerations').mockResolvedValue(0);
    const snapshot = vi.spyOn(pool, 'getSnapshot');
    const first = pool.stageRebalance('user');
    await expect(pool.stageRebalance('user')).rejects.toMatchObject({
      message: expect.stringContaining('already running'),
    });
    await pool.reconcile();
    expect(snapshot).not.toHaveBeenCalled();
    release([]);
    await first;
  });
});

describe('RelayPoolService activation safety and outcomes', () => {
  it('invalidates grants in the same transaction when a drained generation retires', async () => {
    const { db, writes } = queuedDb([
      [{ id: 'new', endpointId: 'endpoint', generation: 1, state: 'draining' }],
      [{ health: { assignmentTunnels: [] } }],
    ]);
    const { pool, policy } = service(db);
    expect(await pool.retireDrainedGenerations()).toBe(1);
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(writes[0].values.state).toBe('retired');
    expect(writes[1].table).toBe(relayPolicyState);
    expect(policy.reconcileAndSync).toHaveBeenCalledOnce();
  });
  it.each([
    'draining',
    'updating',
  ])('rechecks %s after policy synchronization before automatic staging', async (condition) => {
    const { db } = queuedDb([
      [{ id: 'endpoint', ownerKind: 'test' }],
      condition === 'updating' ? [{ state: 'running' }] : [],
      condition === 'draining' ? [{ id: 'relay' }] : [],
    ]);
    const { pool, policy } = service(db);
    expect(await pool.stageRebalance(undefined, { automatic: true, allowNoop: true })).toEqual([]);
    expect(policy.syncSnapshot).toHaveBeenCalledOnce();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('serializes interrupted preparation failure with activation', async () => {
    const { db, writes } = queuedDb([[{ nodeId: 'selected' }]]);
    const { pool, policy } = service(db);
    await (pool as any).failStaging(['new'], new Error('interrupted'));
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(db.execute).toHaveBeenCalledOnce();
    expect(writes[0].values).toMatchObject({ state: 'failed', activationError: 'interrupted' });
    expect(policy.reconcileAndSync).toHaveBeenCalledOnce();
    expect(policy.syncRemoteInstancePolicy).toHaveBeenCalledExactlyOnceWith('selected');
  });

  it('preserves the original committed failure if policy withdrawal cannot reach participants', async () => {
    const { db, writes } = queuedDb([[{ nodeId: 'selected' }]]);
    const { pool, policy, events } = service(db);
    policy.reconcileAndSync.mockRejectedValue(new Error('local disconnected'));
    policy.syncRemoteInstancePolicy.mockRejectedValue(new Error('remote disconnected'));
    await expect((pool as any).failStaging(['new'], new Error('original probe failure'))).resolves.toBeUndefined();
    expect(writes).toHaveLength(2);
    expect(writes[1].table).toBe(relayPolicyState);
    expect(writes[0].values.activationError).toBe('original probe failure');
    expect(policy.syncRemoteInstancePolicy).toHaveBeenCalledWith('selected');
    expect(events.publish).toHaveBeenCalledWith(
      'system.relay.health.changed',
      expect.objectContaining({ action: 'rebalance_failed' })
    );
  });

  it('does not revoke policy when a racing activation already committed', async () => {
    const { db } = queuedDb([]);
    db.updateResult = [];
    const { pool, policy } = service(db);
    await (pool as any).failStaging(['new'], new Error('interrupted'));
    expect(policy.reconcileAndSync).not.toHaveBeenCalled();
  });

  it('withdraws committed failures even when a later transaction in the batch fails', async () => {
    const { db, writes } = queuedDb([[{ nodeId: 'selected' }]]);
    const { pool, policy, events } = service(db);
    db.transaction
      .mockImplementationOnce((callback: any) => callback(db))
      .mockRejectedValueOnce(new Error('later transaction failed'));
    await expect((pool as any).failStaging(['new', 'later'], new Error('probe failed'))).rejects.toThrow(
      'later transaction failed'
    );
    expect(writes).toHaveLength(2);
    expect(writes[1].table).toBe(relayPolicyState);
    expect(writes[0].values).toMatchObject({ state: 'failed', activationError: 'probe failed' });
    expect(policy.reconcileAndSync).toHaveBeenCalledOnce();
    expect(policy.syncRemoteInstancePolicy).toHaveBeenCalledExactlyOnceWith('selected');
    expect(events.publish).toHaveBeenCalledWith(
      'system.relay.health.changed',
      expect.objectContaining({ action: 'rebalance_failed' })
    );
  });
  it.each([
    'pending target',
    'pending source',
    'missing replica',
    'failed target',
    'failed source',
    'ready',
  ])('gates activation on all acknowledgements: %s', async (state) => {
    const assignments =
      state === 'missing replica'
        ? []
        : [
            {
              targetRegistrationState:
                state === 'pending target' ? 'pending' : state === 'failed target' ? 'failed' : 'ready',
              targetRegistrationError: 'candidate unavailable',
            },
          ];
    const probes = [
      {
        state: state === 'pending source' ? 'pending' : state === 'failed source' ? 'failed' : 'ready',
        error: 'source unreachable',
      },
    ];
    const { db, writes } = queuedDb([
      [{ id: 'new', endpointId: 'endpoint', generation: 2, state: 'staging', desiredRedundancy: 1 }],
      assignments,
      probes,
      ...(state.startsWith('failed') ? [[]] : []),
    ]);
    const { pool, policy } = service(db);
    const activated = await (pool as any).tryActivate('new');
    expect(activated).toBe(state === 'ready');
    if (state === 'ready') {
      expect(writes.map(({ values }) => values.state).filter(Boolean)).toEqual(['draining', 'active']);
      expect(policy.reconcileAndSync).toHaveBeenCalledOnce();
    } else if (state.startsWith('failed')) {
      expect(writes).toHaveLength(2);
      expect(writes[1].table).toBe(relayPolicyState);
      expect(writes[0].values).toMatchObject({
        state: 'failed',
        activationError: state === 'failed target' ? 'candidate unavailable' : 'source unreachable',
      });
      expect(policy.reconcileAndSync).toHaveBeenCalledOnce();
    } else expect(writes).toEqual([]);
  });

  it('persists policy sync failures without attempting target preparation', async () => {
    const { pool, policy } = service();
    policy.syncSnapshot.mockRejectedValue(new Error('policy rejected'));
    const fail = vi.spyOn(pool as any, 'failStaging').mockResolvedValue(undefined);
    const prepare = vi.spyOn(pool as any, 'prepareStagedGeneration');
    await (pool as any).prepareGenerations([{ id: 'new', endpointId: 'endpoint', generation: 2 }]);
    expect(fail).toHaveBeenCalledWith(['new'], expect.objectContaining({ message: 'policy rejected' }));
    expect(prepare).not.toHaveBeenCalled();
  });

  it('does not ignore remote policy sync failures', async () => {
    const { db } = queuedDb([[{ nodeId: 'remote' }]]);
    const { pool, policy } = service(db);
    policy.syncRemoteInstancePolicy.mockRejectedValue(new Error('remote unreachable'));
    const fail = vi.spyOn(pool as any, 'failStaging').mockResolvedValue(undefined);
    const prepare = vi.spyOn(pool as any, 'prepareStagedGeneration');
    await (pool as any).prepareGenerations([{ id: 'new', endpointId: 'endpoint', generation: 2 }]);
    expect(fail).toHaveBeenCalledWith(['new'], expect.objectContaining({ message: 'remote unreachable' }));
    expect(prepare).not.toHaveBeenCalled();
  });

  it('prepares selected candidates without consulting an unreachable non-participant', async () => {
    const { db, conditions } = queuedDb([[{ nodeId: 'selected' }]]);
    const { pool, policy } = service(db);
    policy.syncRemoteInstancePolicy.mockImplementation(async (nodeId?: unknown) => {
      if (nodeId === 'unrelated-joining-relay') throw new Error('unreachable');
    });
    const prepare = vi.spyOn(pool as any, 'prepareStagedGeneration').mockResolvedValue(undefined);
    const fail = vi.spyOn(pool as any, 'failStaging');
    await (pool as any).prepareGenerations([{ id: 'new', endpointId: 'endpoint', generation: 2 }]);
    const filter = new PgDialect().sqlToQuery(conditions[0]);
    expect(filter.sql).toContain('"relay_endpoint_assignments"."assignment_generation_id" in');
    expect(filter.params).toEqual(['new', 'system', 'remote']);
    expect(policy.syncRemoteInstancePolicy).toHaveBeenCalledExactlyOnceWith('selected');
    expect(prepare).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
  });

  it.each([
    'failed',
    'active',
  ])('returns the persisted %s outcome instead of the initial staged input', async (state) => {
    const { db } = queuedDb([
      [{ id: 'endpoint', ownerKind: 'test' }],
      [{ id: 'new', state, error: state === 'failed' ? 'candidate unavailable' : null }],
    ]);
    const staged = [{ id: 'new', endpointId: 'endpoint', generation: 2, instanceIds: ['relay'] }];
    db.transaction.mockResolvedValue(staged);
    const { pool, audit } = service(db);
    vi.spyOn(pool as any, 'prepareGenerations').mockResolvedValue(undefined);
    expect(await pool.stageRebalance('user')).toEqual([
      { ...staged[0], state, error: state === 'failed' ? 'candidate unavailable' : null },
    ]);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          generations: [{ id: 'new', state, error: state === 'failed' ? 'candidate unavailable' : null }],
        }),
      })
    );
  });
});

describe('RelayPoolService status', () => {
  function snapshotDb(latest: any[], kind = 'test', capable = true, updateState?: string) {
    const relay = {
      ...instance('relay', 'host'),
      kind: 'local',
      capabilities: { features: capable ? ['relay_pool_v1'] : [] },
    };
    const active = { id: 'old', endpointId: 'endpoint', generation: 1, state: 'active' };
    return queuedDb([
      [relay],
      [{ id: 'endpoint', ownerKind: kind }],
      kind === 'internal_registry' ? [] : [active],
      [{ assignmentGenerationId: 'old', relayInstanceId: 'relay' }],
      latest,
      updateState ? [{ id: 'update', state: updateState, targetArtifact: { version: 'next' } }] : [],
      ...(updateState ? [[]] : []),
    ]);
  }

  it('keeps the latest failure visible alongside the working assignment', async () => {
    const failure = {
      id: 'new',
      endpointId: 'endpoint',
      generation: 2,
      state: 'failed',
      activationError: 'candidate unavailable',
      updatedAt: new Date(),
    };
    const { db } = snapshotDb([failure]);
    const { pool } = service(db);
    const snapshot = await pool.getSnapshot();
    expect(snapshot.failures).toEqual([failure]);
    expect(snapshot.staging).toEqual([]);
    expect(snapshot.state).toBe('degraded');
    expect(snapshot.instances[0].activeAssignments).toBe(1);
    expect(snapshot.automaticRebalanceRetryAt).toBeNull(); // This workload is already balanced.
  });

  it('does not expose failures superseded by a newer successful generation or inactive endpoints', async () => {
    const { db } = snapshotDb([
      { id: 'new', endpointId: 'endpoint', generation: 3, state: 'active' },
      { endpointId: 'removed', state: 'failed' },
    ]);
    const { pool } = service(db);
    expect((await pool.getSnapshot()).failures).toEqual([]);
  });

  it('does not advertise internal registry workloads as rebalance candidates', async () => {
    const { db } = snapshotDb([], 'internal_registry');
    const { pool } = service(db);
    expect((await pool.getSnapshot()).rebalanceAvailable).toBe(false);
  });

  it('does not block a balanced workload solely because a relay uses legacy mode', async () => {
    const { db } = snapshotDb([], 'test', false);
    const { pool } = service(db);
    const snapshot = await pool.getSnapshot();
    expect(snapshot.blockers).toEqual([]);
    expect(snapshot.state).toBe('healthy');
  });

  it.each([
    'running',
    'failed',
  ])('pauses automatic placement only for an ongoing update, not %s unconditionally', async (state) => {
    const { db } = snapshotDb([], 'test', true, state);
    const { pool } = service(db);
    expect((await pool.getSnapshot()).automaticRebalancePaused).toBe(state === 'running');
  });
});

function instance(id: string, faultDomainId: string, state: 'ready' | 'offline' = 'ready') {
  return {
    id,
    poolId: 'system',
    kind: 'remote',
    nodeId: id,
    faultDomainId,
    displayName: id,
    advertisedAddresses: ['127.0.0.1'],
    servicePort: 9443,
    state,
    health: { pressurePercent: 0 },
  } as any;
}

describe('RelayPoolService assignment selection', () => {
  it('selects the requested number of active candidates from separate physical hosts', () => {
    const first = instance('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
    const colocated = instance('00000000-0000-4000-8000-000000000002', first.faultDomainId);
    const remote = instance('00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003');
    const selected = relayPoolInternals.chooseCandidates(
      '20000000-0000-4000-8000-000000000001',
      [first, colocated, remote],
      2
    );
    expect(selected).toHaveLength(2);
    expect(new Set(selected.map(({ faultDomainId }) => faultDomainId)).size).toBe(2);
  });

  it('never fabricates redundant capacity from colocated or offline relay identities', () => {
    const first = instance('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
    const colocated = instance('00000000-0000-4000-8000-000000000002', first.faultDomainId);
    const offline = instance('00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'offline');
    const selected = relayPoolInternals.chooseCandidates(
      '20000000-0000-4000-8000-000000000001',
      [first, colocated, offline],
      10
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.id).toBe(first.id);
  });

  it('keeps provisional Relay enrollment records out of the visible pool', () => {
    const provisional = instance('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
    provisional.state = 'joining';
    provisional.certificateIdentity = null;
    provisional.certificateFingerprint = null;
    const enrolled = instance('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002');
    enrolled.certificateIdentity = 'relay-enrolled';
    enrolled.certificateFingerprint = `sha256:${'a'.repeat(64)}`;

    expect(relayPoolInternals.isEnrolledRelayInstance(provisional)).toBe(false);
    expect(relayPoolInternals.isEnrolledRelayInstance(enrolled)).toBe(true);
  });
});
