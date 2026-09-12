import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import {
  relayAssignmentSourceProbes,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayPolicyState,
} from '@/db/schema/index.js';
import { RelayPolicyService } from './relay-policy.service.js';
import { RelayPoolService } from './relay-pool.service.js';

// Stable unrelated resource projections; keep the real revision mutation,
// reconcileAndSync, refresh gate and serialized daemon delivery in this test.
vi.mock('./relay-policy-reconciler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./relay-policy-reconciler.js')>()),
  backfillRelayNodeFingerprints: vi.fn().mockResolvedValue(undefined),
  reconcileManagedDatabaseRelayPolicy: vi.fn().mockResolvedValue(undefined),
}));

function fixture() {
  let revision = 10;
  const generation = { id: 'new', endpointId: 'endpoint', generation: 2, state: 'staging', desiredRedundancy: 1 };
  const assignment = { targetRegistrationState: 'ready', targetRegistrationError: 'probe failed' };
  const settings: any = { getConfig: async () => ({ relayGrantTtlHours: 4, relay: {} }) };
  const query = (rows: unknown[]) => {
    const q: any = Promise.resolve(rows);
    for (const method of ['where', 'limit', 'innerJoin']) q[method] = () => q;
    return q;
  };
  const db: any = {
    execute: vi.fn().mockResolvedValue(undefined),
    select: () => ({
      from: (table: unknown) =>
        query(
          table === relayEndpointAssignmentGenerations
            ? [generation]
            : table === relayEndpointAssignments
              ? [assignment]
              : table === relayAssignmentSourceProbes
                ? [{ state: 'ready' }]
                : []
        ),
    }),
    selectDistinct: () => ({ from: () => query([]) }),
    update: (table: unknown) => ({
      set: (values: any) => ({
        where: (condition: any) => {
          if (table === relayPolicyState) revision++;
          const params = new PgDialect().sqlToQuery(condition).params;
          const changed = table === relayEndpointAssignmentGenerations && params.includes('new');
          if (changed) generation.state = values.state;
          const q: any = Promise.resolve(undefined);
          q.returning = async () => (changed ? [{ id: 'new' }] : []);
          return q;
        },
      }),
    }),
  };
  db.transaction = async (fn: (tx: any) => unknown) => fn(db);
  const send = vi.fn().mockResolvedValue({ success: true });
  const makePolicy = () => {
    const policy = new RelayPolicyService(db, {} as never, settings, {} as never);
    policy.setNodeDispatch({ sendRelayGrantBundle: send } as never);
    vi.spyOn(policy, 'syncSnapshot').mockImplementation(async () => revision);
    const issuer = (policy as any).grantIssuer;
    issuer.requireState = async () => ({ revision });
    issuer.policyNodeIds = async () => ['source', 'target'];
    vi.spyOn(policy, 'getNodeGrantBundle').mockImplementation(
      async () =>
        ({
          revision: String(revision),
          generatedAtUnixMs: String(Date.now()),
          grants: generation.state === 'failed' ? [] : [{ candidates: [{ assignmentState: generation.state }] }],
        }) as any
    );
    return policy;
  };
  const policy = makePolicy();
  const pool = new RelayPoolService(db, policy, { publish: vi.fn() } as any, {} as any, settings);
  return { pool, policy, makePolicy, send, assignment, generation, revision: () => revision };
}

describe('Relay Pool assignment publication through the real refresh gate', () => {
  it('publishes active candidates immediately after a recent staging grant refresh', async () => {
    const { pool, policy, send, revision } = fixture();
    await policy.refreshAllNodeGrantsIfDue();
    send.mockClear();
    expect(await (pool as any).tryActivate('new')).toBe(true);
    expect(revision()).toBe(11);
    expect(send).toHaveBeenCalledTimes(2);
    for (const [, bundle] of send.mock.calls) expect(bundle.grants[0].candidates[0].assignmentState).toBe('active');
    send.mockClear();
    await policy.reconcileAndSync();
    expect(send).not.toHaveBeenCalled();
  });

  it('withdraws failed candidates despite a fresh grant TTL', async () => {
    const { pool, policy, send, assignment, revision } = fixture();
    await policy.refreshAllNodeGrantsIfDue();
    send.mockClear();
    assignment.targetRegistrationState = 'failed';
    expect(await (pool as any).tryActivate('new')).toBe(false);
    expect(revision()).toBe(11);
    expect(send).toHaveBeenCalledTimes(2);
    for (const [, bundle] of send.mock.calls) expect(bundle.grants).toEqual([]);
  });

  it('retries an undelivered transition on the next normal reconciliation without waiting for TTL', async () => {
    const { pool, policy, send, generation } = fixture();
    await policy.refreshAllNodeGrantsIfDue();
    send
      .mockReset()
      .mockResolvedValueOnce({ success: false, error: 'disconnected' })
      .mockResolvedValue({ success: true });
    await (pool as any).tryActivate('new');
    expect(generation.state).toBe('active');
    expect(send).toHaveBeenCalledTimes(2);
    send.mockClear();
    await policy.reconcileAndSync();
    expect(send).toHaveBeenCalledTimes(2);
    for (const [, bundle] of send.mock.calls) expect(bundle.revision).toBe('11');
  });

  it('retries committed assignment state after service restart', async () => {
    const { pool, policy, makePolicy, send } = fixture();
    await policy.refreshAllNodeGrantsIfDue();
    send.mockReset().mockResolvedValue({ success: false, error: 'offline' });
    await (pool as any).tryActivate('new');
    send.mockReset().mockResolvedValue({ success: true });
    await makePolicy().reconcileAndSync();
    expect(send).toHaveBeenCalledTimes(2);
    for (const [, bundle] of send.mock.calls) expect(bundle.grants[0].candidates[0].assignmentState).toBe('active');
  });
});
