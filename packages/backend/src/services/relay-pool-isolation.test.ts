import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayEndpointAssignmentGenerations } from '@/db/schema/index.js';
import { RelayPoolService, relayPoolInternals } from './relay-pool.service.js';

afterEach(() => vi.restoreAllMocks());
const relays: any[] = ['R1', 'R2'].map((id) => ({
  id,
  kind: 'remote',
  poolId: 'system',
  state: 'ready',
  faultDomainId: id,
  displayName: id,
  nodeId: id,
  certificateIdentity: id,
  certificateFingerprint: id,
  capabilities: { features: id === 'R1' ? ['relay_pool_v1'] : [] },
  health: { pressurePercent: 0 },
}));
const endpointFor = (relayId: string) =>
  Array.from({ length: 100 }, (_, i) => `endpoint-${i}`).find(
    (id) => relayPoolInternals.chooseCandidates(id, relays, 1)[0].id === relayId
  )!;
const A = endpointFor('R1');
const B = endpointFor('R2');
const endpoint = (id: string) => ({ id, ownerKind: 'test' });
function poolFixture(rows: Array<any[] | (() => any[])> = []) {
  const created: any[] = [];
  const select = () => {
    if (!rows.length) throw new Error('Unexpected select');
    const next = rows.shift()!;
    const q: any = Promise.resolve(typeof next === 'function' ? next() : next);
    for (const method of ['from', 'where', 'limit', 'innerJoin', 'orderBy']) q[method] = () => q;
    return q;
  };
  const db: any = {
    select,
    selectDistinctOn: select,
    execute: vi.fn(),
    insert: (table: unknown) => ({
      values: (values: any) => {
        const q: any = Promise.resolve();
        q.returning = async () => {
          if (table !== relayEndpointAssignmentGenerations) throw new Error('Unexpected insert returning');
          const generation = { ...values, id: `new-${created.length}` };
          created.push(generation);
          return [generation];
        };
        return q;
      },
    }),
  };
  db.transaction = (fn: any) => fn(db);
  const policy: any = {
    syncSnapshot: vi.fn().mockResolvedValue(1),
    syncRemoteInstancePolicy: vi.fn().mockResolvedValue(1),
  };
  const pool = new RelayPoolService(
    db,
    policy,
    { publish: vi.fn() } as any,
    { log: vi.fn() } as any,
    { getConfig: async () => ({ relay: { assignmentSpread: { mode: 'fixed', count: 1 } } }) } as any
  );
  return { pool, policy, created };
}

describe('Relay Pool per-workload isolation', () => {
  it('does not block a selected capable relay because an unrelated legacy member is ready', async () => {
    const { pool } = poolFixture([relays, [endpoint(A)], [], [], [], []]);
    const status = await pool.getSnapshot();
    expect(status.blockers).toEqual([]);
    expect(status.rebalanceEndpointIds).toEqual([A]);
    expect(status.rebalanceAvailable).toBe(true);
  });

  it('keeps healthy workloads eligible when another workload selected an incompatible relay', async () => {
    const { pool } = poolFixture([
      relays,
      [endpoint(A), endpoint(B)],
      [],
      [],
      [{ id: 'failed-B', endpointId: B, state: 'failed', updatedAt: new Date() }],
      [],
    ]);
    const status = await pool.getSnapshot();
    expect(status.blockers).toEqual([]);
    expect(status.rebalanceEndpointIds).toEqual([A]);
    expect(status.rebalanceAvailable).toBe(true);
    expect(status.automaticRebalanceRetryAt).toBeNull();
  });

  it('fails closed when the selected candidate lacks capability', async () => {
    const { pool } = poolFixture([relays, [endpoint(B)], [], [], [], []]);
    const status = await pool.getSnapshot();
    expect(status.blockers).toEqual([expect.stringContaining('R2: Relay Pool capability')]);
    expect(status.rebalanceAvailable).toBe(false);
  });

  it('also checks retained draining participants required by the grant projection', async () => {
    const { pool } = poolFixture([
      relays,
      [endpoint(A)],
      [{ id: 'old', endpointId: A, state: 'draining' }],
      [{ assignmentGenerationId: 'old', relayInstanceId: 'R2' }],
      [],
      [],
    ]);
    expect((await pool.getSnapshot()).blockers).toEqual([expect.stringContaining('R2: Relay Pool capability')]);
  });

  it('stages healthy manual work and reports a separate failed outcome for incompatible work', async () => {
    const rows: Array<any[] | (() => any[])> = [
      [endpoint(A), endpoint(B)],
      relays,
      [],
      [],
      [],
      [], // A: no staging, retained, latest, routes
      [],
      [],
      [], // B: no staging, retained, latest; blocked before routes
    ];
    const { pool, created } = poolFixture(rows);
    rows.push(() => created.map((g) => ({ id: g.id, state: g.state, error: g.activationError })));
    const prepare = vi.spyOn(pool as any, 'prepareGenerations').mockImplementation(async (...args: any[]) => {
      for (const g of args[0]) created.find(({ id }) => id === g.id).state = 'active';
    });
    const outcomes = await pool.stageRebalance('user');
    expect(prepare).toHaveBeenCalledWith([expect.objectContaining({ endpointId: A })]);
    expect(outcomes).toEqual([
      expect.objectContaining({ endpointId: A, state: 'active', error: null }),
      expect.objectContaining({
        endpointId: B,
        state: 'failed',
        error: expect.stringContaining('R2: Relay Pool capability'),
      }),
    ]);
  });

  it('applies automatic retry cooldown to the failed endpoint, not the healthy workload', async () => {
    const { pool } = poolFixture();
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(pool, 'retireDrainedGenerations').mockResolvedValue(0);
    vi.spyOn(pool, 'getSnapshot').mockResolvedValue({
      rebalanceAvailable: true,
      rebalancePlanKey: 'stable',
      rebalanceEndpointIds: [A, B],
      blockers: [],
      staging: [],
      failures: [{ endpointId: B, updatedAt: new Date(now) }],
    } as any);
    const stage = vi.spyOn(pool, 'stageRebalance').mockResolvedValue([]);
    await pool.reconcile();
    now += 30_000;
    await pool.reconcile();
    expect(stage).toHaveBeenCalledExactlyOnceWith(undefined, { allowNoop: true, automatic: true, endpointIds: [A] });
  });

  it('deduplicates shared remote syncs while failing only workloads dependent on the broken relay', async () => {
    const { pool, policy } = poolFixture();
    vi.spyOn(pool as any, 'remoteNodesForGenerations').mockImplementation(async (...args: any[]) => [
      { nodeId: args[0][0] === 'B' ? 'R2' : 'R1' },
    ]);
    policy.syncRemoteInstancePolicy.mockImplementation(async (id: string) => {
      if (id === 'R2') throw new Error('R2 disconnected');
      return 1;
    });
    const prepare = vi.spyOn(pool as any, 'prepareStagedGeneration').mockResolvedValue(undefined);
    const fail = vi.spyOn(pool as any, 'failStaging').mockResolvedValue(undefined);
    await (pool as any).prepareGenerations(['A', 'B', 'C'].map((id) => ({ id, endpointId: id, generation: 2 })));
    expect(policy.syncRemoteInstancePolicy).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls.map(([g]: any[]) => g.id).sort()).toEqual(['A', 'C']);
    expect(fail).toHaveBeenCalledExactlyOnceWith(['B'], expect.objectContaining({ message: 'R2 disconnected' }));
  });

  it('waits for healthy work even if persistence of another workload failure rejects', async () => {
    const { pool, policy } = poolFixture();
    vi.spyOn(pool as any, 'remoteNodesForGenerations').mockImplementation(async (...args: any[]) => [
      { nodeId: args[0][0] },
    ]);
    policy.syncRemoteInstancePolicy.mockImplementation(async (id: string) => {
      if (id === 'B') throw new Error('offline');
      return 1;
    });
    const prepare = vi.spyOn(pool as any, 'prepareStagedGeneration').mockResolvedValue(undefined);
    const fail = vi.spyOn(pool as any, 'failStaging').mockRejectedValue(new Error('DB failure'));
    await expect(
      (pool as any).prepareGenerations(['A', 'B'].map((id) => ({ id, endpointId: id, generation: 2 })))
    ).rejects.toThrow('DB failure');
    expect(prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'A' }));
    expect(fail).toHaveBeenCalledOnce();
  });
});
