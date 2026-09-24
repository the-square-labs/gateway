import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayEndpointAssignments, relayPolicyState } from '@/db/schema/index.js';
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
    setRemoteInstanceDrain: vi.fn().mockResolvedValue(undefined),
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
  const locks: unknown[] = [];
  function result(value: unknown[]) {
    const query: any = Promise.resolve(value);
    for (const method of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'leftJoin']) query[method] = () => query;
    query.where = (condition: any) => {
      conditions.push(condition);
      return query;
    };
    query.for = (mode: unknown) => {
      locks.push(mode);
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
    delete: vi.fn((table) => ({
      where: (where: any) => {
        writes.push({ table, where, deleted: true });
        return { returning: async () => [{ id: 'assignment' }] };
      },
    })),
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
  return { db, writes, conditions, locks };
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
    instances: [],
  };
  vi.spyOn(pool, 'retireDrainedGenerations').mockResolvedValue(0);
  vi.spyOn(pool, 'reconcileManualDrains').mockResolvedValue(undefined);
  vi.spyOn(pool, 'fenceSilentRemoteInstances').mockResolvedValue(0);
  vi.spyOn(pool, 'releaseOrphanedUpdateDrains').mockResolvedValue(0);
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
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
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
    vi.spyOn(pool, 'reconcileManualDrains').mockResolvedValue(undefined);
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
  it.each([
    { elapsed: 599_000, admissionState: 'draining', forced: false, expected: null },
    { elapsed: 600_000, admissionState: 'draining', forced: false, expected: true },
    { elapsed: 600_000, admissionState: 'draining', forced: true, expected: null },
    { elapsed: 1_000, admissionState: 'ready', forced: false, expected: false },
    { elapsed: 600_000, admissionState: 'ready', forced: true, expected: true },
  ])('enforces the persisted manual drain deadline: %j', async ({ elapsed, admissionState, forced, expected }) => {
    const now = Date.now();
    const row = {
      ...instance('remote', 'host'),
      manualDrainStartedAt: new Date(now - elapsed),
      drainForcedAt: forced ? new Date(now) : null,
      health: { activeTunnels: 0, admissionState },
    };
    const { db } = queuedDb([[row], [row]]);
    const { pool, policy } = service(db);
    await pool.reconcileManualDrains();
    if (expected === null) expect(policy.setRemoteInstanceDrain).not.toHaveBeenCalled();
    else expect(policy.setRemoteInstanceDrain).toHaveBeenCalledExactlyOnceWith('remote', true, expected);
  });

  it('continues enforcing other drain deadlines when a remote is disconnected', async () => {
    const rows = ['dead', 'live'].map((id) => ({
      ...instance(id, id),
      manualDrainStartedAt: new Date(1),
      health: { activeTunnels: 1 },
    }));
    const { db } = queuedDb([rows, [rows[0]], [rows[1]]]);
    const { pool, policy } = service(db);
    policy.setRemoteInstanceDrain.mockRejectedValueOnce(new Error('offline'));
    await expect(pool.reconcileManualDrains()).resolves.toBeUndefined();
    expect(policy.setRemoteInstanceDrain).toHaveBeenCalledTimes(2);
  });

  it('does not re-drain a member resumed after the timer snapshot', async () => {
    const row = { ...instance('remote', 'host'), manualDrainStartedAt: new Date(1) };
    const { db } = queuedDb([[row], [{ ...row, manualDrainStartedAt: null }]]);
    const { pool, policy } = service(db);
    await pool.reconcileManualDrains();
    expect(policy.setRemoteInstanceDrain).not.toHaveBeenCalled();
  });

  it('serializes a timeout force disconnect with manual resume', async () => {
    const row = { ...instance('remote', 'host'), manualDrainStartedAt: new Date(1) };
    const { db } = queuedDb([[row], [row]]);
    const { pool, policy } = service(db);
    let finish!: () => void;
    policy.setRemoteInstanceDrain.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    const enforcement = pool.reconcileManualDrains();
    await vi.waitFor(() => expect(policy.setRemoteInstanceDrain).toHaveBeenCalled());
    await expect(pool.drainInstance('remote', 'user', false)).rejects.toMatchObject({
      code: 'RELAY_DRAIN_IN_PROGRESS',
    });
    finish();
    await enforcement;
  });

  it('retires an old generation after an offline participant policy expired', async () => {
    const row = {
      id: 'dead',
      state: 'offline',
      lastSeenAt: new Date(1),
      policyExpiresAt: new Date(2),
      health: { activeTunnels: 99 },
    };
    const { db } = queuedDb([
      [{ id: 'old', endpointId: 'endpoint', generation: 1, state: 'draining', drainStartedAt: new Date(3) }],
      [row],
      [row],
    ]);
    expect(await service(db).pool.retireDrainedGenerations()).toBe(1);
  });

  it('invalidates grants in the same transaction when a drained generation retires', async () => {
    const { db, writes, locks } = queuedDb([
      [{ id: 'new', endpointId: 'endpoint', generation: 1, state: 'draining', drainStartedAt: new Date(1000) }],
      [{ lastSeenAt: new Date(2000), health: { assignmentTunnels: [] } }],
      [{ lastSeenAt: new Date(3000), health: { assignmentTunnels: [] } }],
    ]);
    const { pool, policy } = service(db);
    expect(await pool.retireDrainedGenerations()).toBe(1);
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(locks).toEqual(['update']);
    expect(writes[0].values.state).toBe('retired');
    expect(writes[1].table).toBe(relayPolicyState);
    expect(policy.reconcileAndSync).toHaveBeenCalledOnce();
  });
  it('does not retire or revoke a generation when a live tunnel is reported after the optimistic read', async () => {
    const { db, locks } = queuedDb([
      [{ id: 'old', endpointId: 'endpoint', generation: 1, state: 'draining', drainStartedAt: new Date(1000) }],
      [{ id: 'assignment', state: 'draining', lastSeenAt: new Date(2000), health: { assignmentTunnels: [] } }],
      [
        {
          id: 'assignment',
          state: 'draining',
          lastSeenAt: new Date(3000),
          health: { assignmentTunnels: [{ endpointId: 'endpoint', assignmentGeneration: 1, activeTunnels: 1 }] },
        },
      ],
    ]);
    const { pool, policy } = service(db);
    expect(await pool.retireDrainedGenerations()).toBe(0);
    expect(locks).toEqual(['update']);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(policy.reconcileAndSync).not.toHaveBeenCalled();
  });
  it('releases an idle drained relay without retiring another relay with live old-generation tunnels', async () => {
    const { db, writes } = queuedDb([
      [{ id: 'old', endpointId: 'endpoint', generation: 1, state: 'draining', drainStartedAt: new Date(1000) }],
      [
        { id: 'empty', state: 'draining', lastSeenAt: new Date(2000), health: { assignmentTunnels: [] } },
        {
          id: 'busy',
          state: 'ready',
          lastSeenAt: new Date(2000),
          health: { assignmentTunnels: [{ endpointId: 'endpoint', assignmentGeneration: 1, activeTunnels: 2 }] },
        },
      ],
    ]);
    const { pool, policy } = service(db);
    expect(await pool.retireDrainedGenerations()).toBe(0);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ table: relayEndpointAssignments, deleted: true });
    const filter = new PgDialect().sqlToQuery(writes[0].where);
    expect(filter.params).toContain('empty');
    expect(filter.params).not.toContain('busy');
    expect(filter.sql).toContain("'draining'");
    expect(filter.sql).toContain('last_seen_at');
    expect(writes[1].table).toBe(relayPolicyState);
    expect(policy.reconcileAndSync).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    new Date(500),
  ])('does not retire assignments from missing or pre-handover observations (%s)', async (lastSeenAt) => {
    const { db } = queuedDb([
      [{ id: 'old', endpointId: 'endpoint', generation: 1, state: 'draining', drainStartedAt: new Date(1000) }],
      [{ id: 'empty', state: 'draining', lastSeenAt, health: { assignmentTunnels: [] } }],
    ]);
    expect(await service(db).pool.retireDrainedGenerations()).toBe(0);
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('retires a generation whose last idle assignment was already released', async () => {
    const { db } = queuedDb([[{ id: 'empty', state: 'draining' }], [], []]);
    expect(await service(db).pool.retireDrainedGenerations()).toBe(1);
  });

  it.each([
    'drain',
    'force disconnect',
  ])('%s evacuates only affected workloads through verified automatic staging', async (action) => {
    const remote = { ...instance('remote', 'host'), state: 'draining' };
    const { db } = queuedDb([[remote], [{ endpointId: 'affected' }]]);
    const { pool, policy } = service(db);
    const stage = vi.spyOn(pool, 'stageRebalance').mockResolvedValue([]);
    vi.spyOn(pool, 'retireDrainedGenerations').mockResolvedValue(0);
    if (action === 'drain') await pool.drainInstance('remote', 'user');
    else await pool.forceDisconnectInstance('remote', 'user');
    expect(policy.setRemoteInstanceDrain).toHaveBeenCalled();
    expect(stage).toHaveBeenCalledExactlyOnceWith(undefined, {
      automatic: true,
      allowNoop: true,
      evacuation: true,
      endpointIds: ['affected'],
    });
  });
  it('persists manual drain before sending the command and retains it on delivery failure', async () => {
    const { db, writes } = queuedDb([[instance('remote', 'host')]]);
    const { pool, policy } = service(db);
    policy.setRemoteInstanceDrain.mockImplementation(async () => {
      expect(writes[0].values).toMatchObject({ state: 'draining' });
      expect(writes[0].values.manualDrainStartedAt).toBeDefined();
      throw new Error('disconnected');
    });
    await expect(pool.drainInstance('remote', 'user')).rejects.toThrow('disconnected');
    expect(writes).toHaveLength(1);
  });

  it('does not erase manual drain intent when resume delivery fails', async () => {
    const { db, writes } = queuedDb([
      [{ ...instance('remote', 'host'), state: 'draining', manualDrainStartedAt: new Date(1) }],
    ]);
    const { pool, policy } = service(db);
    policy.setRemoteInstanceDrain.mockRejectedValue(new Error('disconnected'));
    await expect(pool.drainInstance('remote', 'user', false)).rejects.toThrow('disconnected');
    expect(writes).toHaveLength(0);
  });

  it('refuses an operator resume of a relay an unfinished update run drained', async () => {
    const { db, writes } = queuedDb([
      [{ ...instance('remote', 'host'), state: 'draining', manualDrainStartedAt: null }],
      [{ id: 'step' }],
    ]);
    const { pool, policy } = service(db);
    await expect(pool.drainInstance('remote', 'user', false)).rejects.toMatchObject({ code: 'RELAY_HELD_BY_UPDATE' });
    expect(policy.setRemoteInstanceDrain).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('does not enroll update-owned drains in the manual ten-minute deadline', async () => {
    const { db, writes } = queuedDb([[{ ...instance('remote', 'host'), manualDrainStartedAt: null }], []]);
    const { pool } = service(db);
    await pool.drainInstance('remote', 'user', true, { manual: false });
    expect(writes[0].values).toMatchObject({ state: 'draining', manualDrainStartedAt: null });
  });

  it.each([true, false])('preserves existing manual drain through update-owned action enabled=%s', async (enabled) => {
    const startedAt = new Date(1);
    const forcedAt = new Date(2);
    const { db, writes } = queuedDb([
      [{ ...instance('remote', 'host'), state: 'draining', manualDrainStartedAt: startedAt, drainForcedAt: forcedAt }],
      [],
    ]);
    const { pool, policy } = service(db);
    await pool.drainInstance('remote', 'user', enabled, { manual: false });
    expect(policy.setRemoteInstanceDrain).toHaveBeenCalledExactlyOnceWith('remote', true);
    expect(writes[0].values).toMatchObject({
      state: 'draining',
      manualDrainStartedAt: startedAt,
      drainForcedAt: forcedAt,
    });
  });
  it('rechecks maintenance after policy synchronization before automatic staging', async () => {
    const { db } = queuedDb([[{ id: 'endpoint', ownerKind: 'test' }], [{ state: 'running' }]]);
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
    const poolFence = new PgDialect().sqlToQuery(db.execute.mock.calls[0][0]);
    expect(poolFence.sql).toContain('gateway-relay-pool-rebalance');
    expect(db.execute).toHaveBeenCalledTimes(2);
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
    vi.spyOn(pool as any, 'tryActivate').mockResolvedValue(true);
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
  it('builds a bounded newest-first history query with readable JSONB domain names', () => {
    const { pool } = service(drizzle({ query: vi.fn() } as any));
    const query = (pool as any).getRecentAttempts().toSQL();
    expect(query.sql).toContain('"proxy_hosts"."domain_names"->>0');
    expect(query.sql).toContain('"managed_database_instances"."name"');
    expect(query.sql).toContain('order by "relay_endpoint_assignment_generations"."created_at" desc');
    expect(query.sql).toContain('limit');
    expect(query.params.at(-1)).toBe(20);
  });

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
      latest,
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
    expect(snapshot.state).toBe('healthy');
    expect(snapshot.attempts).toEqual([failure]);
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
    'paused',
  ])('pauses automatic placement only for an ongoing update, not %s unconditionally', async (state) => {
    const { db } = snapshotDb([], 'test', true, state);
    const { pool } = service(db);
    expect((await pool.getSnapshot()).automaticRebalancePaused).toBe(state === 'running');
  });

  it('reports why a relay refuses Gateway policy next to the instance', async () => {
    const { db } = snapshotDb([]);
    const { pool, policy } = service(db);
    const status = { state: 'reenrollment_required', message: 'Re-enroll it', observedAt: 'now', trustedKeyIds: [] };
    (policy as any).describePolicyTrust = vi.fn().mockResolvedValue(new Map([['relay', status]]));
    expect((await pool.getSnapshot()).instances[0]).toMatchObject({ policyTrust: status });
  });

  it('keeps the pool status available when trust cannot be assessed', async () => {
    const { db } = snapshotDb([]);
    const { pool, policy } = service(db);
    (policy as any).describePolicyTrust = vi.fn().mockRejectedValue(new Error('database unavailable'));
    expect((await pool.getSnapshot()).instances[0]).toMatchObject({ policyTrust: null });
  });
});

describe('RelayPoolService remote relay liveness and recovery', () => {
  it('marks remote relays that stopped reporting offline, after a startup grace', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T00:00:00Z'));
    const { db, writes, conditions } = queuedDb([]);
    const { pool, events } = service(db);
    db.updateResult = [];
    expect(await pool.fenceSilentRemoteInstances()).toBe(0);
    expect(writes).toEqual([]); // Reconnecting relays get time to report after a Gateway start.

    vi.advanceTimersByTime(90_000);
    db.updateResult = [{ id: 'silent' }];
    expect(await pool.fenceSilentRemoteInstances()).toBe(1);
    expect(writes[0].values).toMatchObject({ state: 'offline' });
    const where = new PgDialect().sqlToQuery(writes[0].where);
    expect(where.sql).toContain('coalesce("relay_instances"."last_seen_at", "relay_instances"."updated_at") <');
    expect(where.params).toEqual(expect.arrayContaining(['system', 'remote', 'synchronizing', 'ready', 'draining']));
    expect(events.publish).toHaveBeenCalledWith('system.relay.health.changed', expect.anything());
    void conditions;
  });

  it('resumes a relay a finished update left drained, but not one an unfinished run holds', async () => {
    const { db } = queuedDb([
      [{ id: 'orphaned' }, { id: 'held' }],
      [], // orphaned: no in-flight step of an unfinished run
      [{ state: 'draining', manualDrainStartedAt: null }],
      [{ id: 'step' }], // held: a paused run still owns the drain
    ]);
    const { pool } = service(db);
    const resume = vi.spyOn(pool as any, 'setInstanceDrain').mockResolvedValue(undefined);
    expect(await pool.releaseOrphanedUpdateDrains(0)).toBe(1);
    expect(resume).toHaveBeenCalledExactlyOnceWith('orphaned', null, false, false);
    // Throttled between passes.
    expect(await pool.releaseOrphanedUpdateDrains(1)).toBe(0);
  });

  it('issues a single-use re-enrollment token only for an enrolled remote relay', async () => {
    const remote = { ...instance('relay-1', 'host'), nodeId: 'node-1', servicePort: 9443 };
    const { db, writes } = queuedDb([[remote], [{ buildVersion: 'v2.11.0-rc.7' }]]);
    const { pool, audit } = service(db);
    db.updateResult = [{ id: 'node-1' }];
    const issued = await pool.issueRelayReenrollment('relay-1', 'admin');
    expect(issued).toMatchObject({
      instanceId: 'relay-1',
      nodeId: 'node-1',
      advertiseAddress: '127.0.0.1',
      // The installer pins the release the pool runs.
      relayVersion: 'v2.11.0-rc.7',
    });
    expect(issued.enrollmentToken).toMatch(/^gw_node_v2_[0-9a-f]{16}_[0-9a-f]{48}$/);
    const write = writes[0];
    expect(write.values.enrollmentTokenSelector).toBe(issued.enrollmentToken.split('_')[3]);
    expect(write.values.enrollmentTokenHash).not.toContain(issued.enrollmentToken);
    const where = new PgDialect().sqlToQuery(write.where);
    expect(where.sql).toContain('"nodes"."status" <> $');
    expect(where.sql).toContain('"nodes"."certificate_serial" is not null');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'relay.instance.reenrollment_token.issue', resourceId: 'relay-1' })
    );

    const local = { ...remote, kind: 'local', nodeId: null };
    const { pool: localPool } = service(queuedDb([[local]]).db);
    await expect(localPool.issueRelayReenrollment('relay-1', 'admin')).rejects.toMatchObject({
      code: 'RELAY_REENROLLMENT_UNSUPPORTED',
    });

    const pending = queuedDb([[remote]]);
    pending.db.updateResult = [];
    await expect(service(pending.db).pool.issueRelayReenrollment('relay-1', 'admin')).rejects.toMatchObject({
      code: 'RELAY_NOT_ENROLLED',
    });

    // A development build has no release to pin: the installer resolves one itself.
    const development = queuedDb([[remote], [{ buildVersion: 'dev' }]]);
    development.db.updateResult = [{ id: 'node-1' }];
    await expect(service(development.db).pool.issueRelayReenrollment('relay-1', 'admin')).resolves.toMatchObject({
      relayVersion: null,
    });
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

describe('RelayPoolService placement during updates and mixed versions', () => {
  it('evacuates a relay an update drains even while the update pauses automatic placement', async () => {
    const { db } = queuedDb([[{ endpointId: 'endpoint-1' }]]);
    const { pool } = service(db);
    const stage = vi.spyOn(pool, 'stageRebalance').mockResolvedValue([]);
    await (pool as any).evacuateInstance('remote');
    expect(stage).toHaveBeenCalledWith(undefined, expect.objectContaining({ automatic: true, evacuation: true }));
  });

  it('skips the update freeze only for evacuation', async () => {
    const endpoint = { id: 'endpoint-1', ownerKind: 'managed_database', ownerId: 'db-1', status: 'active' };
    // Automatic placement stops at the unfinished update run.
    const frozen = queuedDb([[endpoint], [{ id: 'run', state: 'draining' }]]);
    await expect(
      (service(frozen.db).pool as any).stageRebalanceOnce(undefined, { automatic: true, allowNoop: true })
    ).resolves.toEqual([]);
    // Evacuation goes on to placement (here: no ready relay to move to).
    const evacuating = queuedDb([[endpoint], []]);
    await expect(
      (service(evacuating.db).pool as any).stageRebalanceOnce(undefined, {
        automatic: true,
        allowNoop: true,
        evacuation: true,
      })
    ).rejects.toMatchObject({ code: 'RELAY_CAPACITY_UNAVAILABLE' });
  });

  it('does not fail an update drain when its workloads cannot move yet', async () => {
    const { db } = queuedDb([[{ ...instance('remote', 'host'), manualDrainStartedAt: null }]]);
    const { pool } = service(db);
    vi.spyOn(pool as any, 'evacuateInstance').mockRejectedValue(new Error('no ready relay'));
    await expect(pool.drainInstance('remote', null, true, { manual: false })).resolves.toBeUndefined();
    const manual = queuedDb([[{ ...instance('remote', 'host'), manualDrainStartedAt: null }]]);
    const { pool: manualPool } = service(manual.db);
    vi.spyOn(manualPool as any, 'evacuateInstance').mockRejectedValue(new Error('no ready relay'));
    await expect(manualPool.drainInstance('remote', 'user', true)).rejects.toThrow('no ready relay');
  });

  it('keeps a workload whose path has a daemon without pool support on the local relay', async () => {
    const local = {
      ...instance('local', 'gateway-host'),
      kind: 'local',
      capabilities: { features: ['relay_pool_v1'] },
    };
    const remote = { ...instance('remote', 'remote-host'), capabilities: { features: ['relay_pool_v1'] } };
    const active = { id: 'old', endpointId: 'endpoint', generation: 1, state: 'active' };
    const snapshotFor = async (assignedTo: string) => {
      const { pool, policy } = service(
        queuedDb([
          [local, remote],
          [{ id: 'endpoint', ownerKind: 'managed_database' }],
          [active],
          [{ assignmentGenerationId: 'old', relayInstanceId: assignedTo }],
          [],
          [],
          [],
        ]).db
      );
      (policy as any).poolIncapableEndpointIds = vi.fn().mockResolvedValue(new Set(['endpoint']));
      return pool.getSnapshot();
    };
    // Assigned to a remote relay only: legacy grants cannot reach it, so it moves to the local relay.
    const moved = await snapshotFor('remote');
    expect(moved.rebalanceEndpointIds).toEqual(['endpoint']);
    expect(moved.rebalancePlanKey).toBe(
      createHash('sha256')
        .update(JSON.stringify([{ endpointId: 'endpoint', instanceIds: ['local'], blockers: [] }]))
        .digest('hex')
    );
    // Already on the local relay: nothing to do, even though spread would add the remote relay.
    expect((await snapshotFor('local')).rebalanceAvailable).toBe(false);
  });

  it('lets an update run wait for a running drain action instead of failing', async () => {
    const { pool } = service({});
    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    const setDrain = vi
      .spyOn(pool as any, 'setInstanceDrain')
      .mockReturnValueOnce(running)
      .mockResolvedValue(undefined);
    const cleanup = (pool as any).withDrainAction('remote', () => (pool as any).setInstanceDrain('remote'));
    // An operator gets a conflict while another action runs.
    await expect(pool.drainInstance('remote', 'user', true)).rejects.toMatchObject({ code: 'RELAY_DRAIN_IN_PROGRESS' });
    // An update run waits its turn.
    const update = pool.drainInstance('remote', null, true, { manual: false });
    await Promise.resolve();
    expect(setDrain).toHaveBeenCalledTimes(1);
    release();
    await cleanup;
    await expect(update).resolves.toBeUndefined();
    expect(setDrain).toHaveBeenCalledTimes(2);
  });

  it('keeps moving workloads off drained relays while an update pauses placement', async () => {
    const { pool } = reconciliationHarness();
    const evacuate = vi.spyOn(pool as any, 'evacuateInstance').mockRejectedValueOnce(new Error('rebalance running'));
    evacuate.mockResolvedValue(undefined);
    const snapshot = await pool.getSnapshot();
    Object.assign(snapshot, {
      automaticRebalancePaused: true,
      instances: [
        { id: 'drained', kind: 'remote', state: 'draining', activeAssignments: 2 },
        { id: 'empty', kind: 'remote', state: 'draining', activeAssignments: 0 },
        { id: 'ready', kind: 'remote', state: 'ready', activeAssignments: 3 },
      ],
    });
    await pool.reconcile();
    expect(evacuate).toHaveBeenCalledExactlyOnceWith('drained');
    // Retried after a pause, not on every tick.
    await pool.reconcile();
    expect(evacuate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    await pool.reconcile();
    expect(evacuate).toHaveBeenCalledTimes(2);
  });
});
