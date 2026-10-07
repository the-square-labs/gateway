import { describe, expect, it, vi } from 'vitest';
import { GRANT_KEY_PUBLICATION_MS, RelayGrantKeyService } from './relay-grant-key.service.js';

function queryable(rows: unknown[]) {
  const query: any = Promise.resolve(rows);
  for (const method of ['from', 'where', 'limit']) query[method] = () => query;
  return query;
}

function fixture(options: {
  pendingCreatedAt: Date;
  publishedAtRevision?: number | null;
  instances?: Array<{ appliedPolicyRevision: number | null; capabilities: unknown }>;
  settings?: { relayGrantTtlHours: number; relayPolicyLeaseHours: number };
}) {
  const updates: unknown[] = [];
  const tx: any = {
    execute: vi.fn(),
    select: vi.fn(() =>
      queryable([
        {
          id: 'pending',
          status: 'pending',
          createdAt: options.pendingCreatedAt,
          publishedAtRevision: options.publishedAtRevision ?? 1,
        },
      ])
    ),
    update: vi.fn(() => ({
      set: (values: unknown) => {
        updates.push(values);
        return { where: async () => [] };
      },
    })),
  };
  const dbSelect = vi.fn(() => queryable(options.instances ?? []));
  const db: any = { transaction: vi.fn((callback: (writer: unknown) => unknown) => callback(tx)), select: dbSelect };
  const settings = {
    getConfig: vi.fn().mockResolvedValue(options.settings ?? { relayGrantTtlHours: 4, relayPolicyLeaseHours: 72 }),
  };
  return { service: new RelayGrantKeyService(db, {} as never, settings as never), updates, dbSelect };
}

describe('RelayGrantKeyService rotation', () => {
  it('publishes a pending key to every relay before it signs grants', async () => {
    const now = new Date('2026-09-24T12:00:00Z');
    const syncSnapshot = vi.fn().mockResolvedValue(1);
    const refreshGrants = vi.fn().mockResolvedValue(undefined);

    // Remote relays learn keys from snapshots within one policy lease; until then they would
    // refuse renewed endpoint grants and close the endpoint's tunnels.
    const early = fixture({ pendingCreatedAt: new Date(now.getTime() - GRANT_KEY_PUBLICATION_MS + 1_000) });
    await expect(early.service.rotateIfDue(now, syncSnapshot, refreshGrants)).resolves.toBe(false);
    expect(syncSnapshot).toHaveBeenCalledOnce();
    expect(early.updates).toEqual([]);
    expect(refreshGrants).not.toHaveBeenCalled();

    // No relay instances enrolled: nothing to wait on, so publication alone is enough.
    const published = fixture({ pendingCreatedAt: new Date(now.getTime() - GRANT_KEY_PUBLICATION_MS) });
    await expect(published.service.rotateIfDue(now, syncSnapshot, refreshGrants)).resolves.toBe(true);
    expect(published.updates).toEqual([
      expect.objectContaining({ status: 'verification_only' }),
      expect.objectContaining({ status: 'active', activatedAt: now }),
    ]);
    expect(refreshGrants).toHaveBeenCalledOnce();
  });

  it('publishes a pending key at the pool snapshot revision relays report, not the global one', async () => {
    const now = new Date('2026-09-24T12:00:00Z');
    const reads = [
      [], // no pending key yet
      [{ activatedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000) }],
      [{ revision: '1300' }], // the pool runs ahead of the global revision (1000)
    ];
    const inserted: Array<Record<string, unknown>> = [];
    const tx: any = {
      execute: vi.fn(),
      select: vi.fn(() => queryable(reads.shift() ?? [])),
      update: vi.fn(() => ({ set: () => ({ where: async () => [] }) })),
      insert: vi.fn(() => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          return { returning: async () => [{ id: 'pending' }] };
        },
      })),
    };
    const db: any = { transaction: vi.fn((callback: (writer: unknown) => unknown) => callback(tx)) };
    const crypto = { encryptPrivateKey: () => ({ encryptedPrivateKey: 'k', encryptedDek: 'd' }) };
    const service = new RelayGrantKeyService(db, crypto as never, { getConfig: vi.fn() } as never);

    await expect(service.rotateIfDue(now, vi.fn().mockResolvedValue(1), vi.fn())).resolves.toBe(false);

    // A relay that applied pool revision 1290 before the key existed must not count as acknowledged.
    expect(inserted).toEqual([expect.objectContaining({ status: 'pending', publishedAtRevision: 1301 })]);
  });

  it('outlasts the relay policy lease', () => {
    expect(GRANT_KEY_PUBLICATION_MS).toBeGreaterThan(15 * 60 * 1000);
  });

  it('withholds activation from an instance that has neither acknowledged nor exhausted its lease', async () => {
    const pendingCreatedAt = new Date('2026-09-24T00:00:00Z');
    const now = new Date(pendingCreatedAt.getTime() + GRANT_KEY_PUBLICATION_MS);
    const syncSnapshot = vi.fn().mockResolvedValue(1);
    const refreshGrants = vi.fn().mockResolvedValue(undefined);

    // A long-lease relay that hasn't applied the publishing revision, and is nowhere near its
    // 72-hour lease: activating now would leave it unable to verify grants once it reconnects.
    const isolated = fixture({
      pendingCreatedAt,
      publishedAtRevision: 11,
      instances: [{ appliedPolicyRevision: 10, capabilities: { features: ['policy_long_lease_v1'] } }],
      settings: { relayGrantTtlHours: 4, relayPolicyLeaseHours: 72 },
    });
    await expect(isolated.service.rotateIfDue(now, syncSnapshot, refreshGrants)).resolves.toBe(false);
    expect(isolated.updates).toEqual([]);
    expect(refreshGrants).not.toHaveBeenCalled();

    // The same instance, but it has now applied the publishing revision: it demonstrably has the
    // key, so activation proceeds immediately without waiting out the rest of its lease.
    const acknowledged = fixture({
      pendingCreatedAt,
      publishedAtRevision: 11,
      instances: [{ appliedPolicyRevision: 11, capabilities: { features: ['policy_long_lease_v1'] } }],
      settings: { relayGrantTtlHours: 4, relayPolicyLeaseHours: 72 },
    });
    await expect(acknowledged.service.rotateIfDue(now, syncSnapshot, refreshGrants)).resolves.toBe(true);
  });
});

describe('RelayGrantKeyService activation gate (allInstancesReady)', () => {
  function gate() {
    return new RelayGrantKeyService({} as never, {} as never, {} as never) as any;
  }

  it('activates once every instance acknowledged the publishing revision', () => {
    const pending = { id: 'p', createdAt: new Date('2026-09-27T00:00:00Z'), publishedAtRevision: 11 };
    // Only a minute later: nowhere near either lease bound, but the instance already applied it.
    const now = new Date(pending.createdAt.getTime() + 60_000);
    const instances = [{ appliedPolicyRevision: 11, capabilities: { features: [] } }];
    expect(gate().allInstancesReady(instances, pending, now, 72)).toBe(true);
  });

  it('withholds an isolated long-lease relay until its own lease (plus clock skew) elapses', () => {
    const pending = { id: 'p', createdAt: new Date('2026-09-27T00:00:00Z'), publishedAtRevision: 11 };
    const instances = [{ appliedPolicyRevision: 5, capabilities: { features: ['policy_long_lease_v1'] } }];
    const service = gate();
    const beforeLeaseElapsed = new Date(pending.createdAt.getTime() + 72 * 60 * 60 * 1000);
    expect(service.allInstancesReady(instances, pending, beforeLeaseElapsed, 72)).toBe(false);
    const afterLeaseElapsed = new Date(pending.createdAt.getTime() + 72 * 60 * 60 * 1000 + 2 * 60 * 1000 + 1_000);
    expect(service.allInstancesReady(instances, pending, afterLeaseElapsed, 72)).toBe(true);
  });

  it('bounds a legacy relay by the 15-minute lease regardless of the configured long lease', () => {
    const pending = { id: 'p', createdAt: new Date('2026-09-27T00:00:00Z'), publishedAtRevision: 11 };
    const instances = [{ appliedPolicyRevision: 5, capabilities: { features: [] } }];
    const service = gate();
    const beforeLeaseElapsed = new Date(pending.createdAt.getTime() + 16 * 60 * 1000);
    expect(service.allInstancesReady(instances, pending, beforeLeaseElapsed, 72)).toBe(false);
    const afterLeaseElapsed = new Date(pending.createdAt.getTime() + 17 * 60 * 1000 + 1_000);
    expect(service.allInstancesReady(instances, pending, afterLeaseElapsed, 72)).toBe(true);
  });

  it('treats a pre-migration null publishedAtRevision as already published', () => {
    const pending = { id: 'p', createdAt: new Date('2026-09-27T00:00:00Z'), publishedAtRevision: null };
    const instances = [{ appliedPolicyRevision: 0, capabilities: { features: [] } }];
    expect(gate().allInstancesReady(instances, pending, pending.createdAt, 72)).toBe(true);
  });
});

describe('RelayGrantKeyService retiredKeyVerifyUntilMs', () => {
  function service() {
    return new RelayGrantKeyService({} as never, {} as never, {} as never) as any;
  }

  it('follows the effective grant TTL once it exceeds the legacy retention floor', () => {
    const now = new Date('2026-09-27T00:00:00Z');
    // A short grant TTL and lease: the 48h05m legacy floor dominates.
    expect(service().retiredKeyVerifyUntilMs(now, { relayGrantTtlHours: 4, relayPolicyLeaseHours: 1 })).toBe(
      now.getTime() + 48 * 60 * 60 * 1000 + 5 * 60 * 1000
    );
    // The longest configurable lease raises the effective grant TTL to ceil(168 * 4 / 3) = 224h,
    // which now dominates the floor.
    expect(service().retiredKeyVerifyUntilMs(now, { relayGrantTtlHours: 4, relayPolicyLeaseHours: 168 })).toBe(
      now.getTime() + 224 * 60 * 60 * 1000 + 5 * 60 * 1000
    );
  });

  it('never exceeds the relay grant.MaxTTL cap', () => {
    const now = new Date('2026-09-27T00:00:00Z');
    // Settings outside the validated range must not be able to push retention past what the
    // relay itself would ever accept a grant for.
    const verifyUntilMs = service().retiredKeyVerifyUntilMs(now, {
      relayGrantTtlHours: 10_000,
      relayPolicyLeaseHours: 10_000,
    });
    expect(verifyUntilMs).toBeLessThan(now.getTime() + 240 * 60 * 60 * 1000);
  });
});
