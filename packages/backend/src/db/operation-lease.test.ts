import { describe, expect, it, vi } from 'vitest';
import {
  OPERATION_LEASE_PROCESS,
  OperationLeaseLostError,
  OperationLeaseStore,
  operationLeaseKey,
} from './operation-lease.js';
import { createFakeOperationLeaseDb } from './operation-lease.test-helpers.js';

describe('OperationLeaseStore', () => {
  it('lets exactly one of two processes claim a key at once', async () => {
    const { db } = createFakeOperationLeaseDb();
    const processA = new OperationLeaseStore(db);
    const processB = new OperationLeaseStore(db);

    const [a, b] = await Promise.all([processA.claim(['k'], { by: 'a' }), processB.claim(['k'], { by: 'b' })]);

    expect(a.acquired).toBe(true);
    expect(b).toMatchObject({ acquired: false, key: 'k', lease: { data: { by: 'a' } } });
  });

  it('claims several keys all or nothing', async () => {
    const { db, rows } = createFakeOperationLeaseDb();
    const store = new OperationLeaseStore(db);
    await store.claim(['b'], { by: 'first' });

    await expect(store.claim(['a', 'b'], { by: 'second' })).resolves.toMatchObject({ acquired: false, key: 'b' });
    expect(rows.has('a')).toBe(false);
  });

  it('takes over a lapsed lease, and a live one only when it is replaceable', async () => {
    const { db, rows } = createFakeOperationLeaseDb();
    const store = new OperationLeaseStore(db);
    rows.set('k', { token: 'dead', holder: 'gone', expiresAt: new Date(Date.now() - 1), data: {} });
    const claimed = await store.claim(['k'], { step: 1 });
    expect(claimed.acquired).toBe(true);

    await expect(store.claim(['k'], { step: 2 })).resolves.toMatchObject({ acquired: false });
    await expect(
      store.claim(['k'], { step: 2 }, { replaceable: (lease) => lease.data.step === 1 })
    ).resolves.toMatchObject({ acquired: true });
  });

  it('renews and releases only for the holder, and keeps a finished outcome readable', async () => {
    const { db, rows } = createFakeOperationLeaseDb();
    const store = new OperationLeaseStore(db, { ttlMs: 1_000 });
    const claim = await store.claim(['k'], { outcome: null as string | null });
    if (!claim.acquired) throw new Error('not claimed');

    await expect(store.renew(['k'], 'someone-else')).resolves.toEqual([]);
    await store.release(['k'], 'someone-else');
    expect(rows.has('k')).toBe(true);

    await expect(store.renew(['k'], claim.token)).resolves.toEqual(['k']);
    await store.release(['k'], claim.token, { data: { outcome: 'done' }, retainMs: 5_000 });
    await expect(store.read('k')).resolves.toMatchObject({ token: claim.token, data: { outcome: 'done' } });

    await store.release(['k'], claim.token);
    expect(rows.has('k')).toBe(false);
  });

  it('renews a held lease and reports a key another process took over', async () => {
    vi.useFakeTimers();
    try {
      const { db, rows } = createFakeOperationLeaseDb();
      const store = new OperationLeaseStore(db, { ttlMs: 3_000, heartbeatMs: 1_000 });
      const claim = await store.claim(['k'], {});
      if (!claim.acquired) throw new Error('not claimed');
      const lost = vi.fn();
      const heartbeat = store.hold(() => ['k'], claim.token, lost, { since: claim.claimedAt });
      const expiry = () => rows.get('k')!.expiresAt.getTime();
      const before = expiry();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(expiry()).toBeGreaterThan(before);
      expect(lost).not.toHaveBeenCalled();
      expect(heartbeat.lost).toBe(false);

      rows.set('k', { ...rows.get('k')!, token: 'other-process' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(lost).toHaveBeenCalledWith('k');
      // The operation is told to stop acting as the owner, and renewals stop.
      expect(heartbeat.lost).toBe(true);
      expect(heartbeat.signal.aborted).toBe(true);
      expect(heartbeat.signal.reason).toBeInstanceOf(OperationLeaseLostError);
      expect(heartbeat.signal.reason).toMatchObject({ keys: ['k'], kind: 'taken-over' });
      const takenExpiry = expiry();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(expiry()).toBe(takenExpiry);
      expect(lost).toHaveBeenCalledTimes(1);
      heartbeat.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // rc.11 data review F6: a holder whose renewals failed (a database blip)
  // kept running as the owner after its lease lapsed and another process
  // took the key.
  it('declares the lease lost once renewals have not confirmed it for a full TTL', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeOperationLeaseDb();
      let databaseDown = false;
      const transaction = fake.db.transaction.bind(fake.db);
      const db = Object.assign(Object.create(fake.db), {
        transaction: (fn: never) => (databaseDown ? Promise.reject(new Error('connection lost')) : transaction(fn)),
      });
      const store = new OperationLeaseStore(db, { ttlMs: 3_000, heartbeatMs: 1_000 });
      const claim = await store.claim(['k'], {});
      if (!claim.acquired) throw new Error('not claimed');
      const lost = vi.fn();
      const heartbeat = store.hold(() => ['k'], claim.token, lost, { since: claim.claimedAt });

      databaseDown = true;
      await vi.advanceTimersByTimeAsync(2_000);
      // Failed renewals alone do not end the lease while it is still within its TTL.
      expect(heartbeat.lost).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(heartbeat.lost).toBe(true);
      expect(heartbeat.signal.reason).toMatchObject({ keys: ['k'], kind: 'unconfirmed' });
      expect(lost).toHaveBeenCalledWith('k');

      // The database is back, but the operation already stopped owning the key.
      databaseDown = false;
      await expect(heartbeat.confirm()).resolves.toBe(false);
      heartbeat.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts the TTL from the claim, and checks it when read even before a heartbeat runs', async () => {
    const { db } = createFakeOperationLeaseDb();
    const store = new OperationLeaseStore(db, { ttlMs: 60_000 });
    const claim = await store.claim(['k'], {});
    if (!claim.acquired) throw new Error('not claimed');

    // A claim sent a full TTL ago (the event loop was blocked since) is not relied on.
    const heartbeat = store.hold(() => ['k'], claim.token, undefined, { since: claim.claimedAt - 60_000 });
    expect(heartbeat.lost).toBe(true);
    expect(heartbeat.signal.aborted).toBe(true);
    heartbeat.stop();
  });

  it('confirms a held lease on demand, and reports it lost once another process holds it', async () => {
    const { db, rows } = createFakeOperationLeaseDb();
    const store = new OperationLeaseStore(db);
    const claim = await store.claim(['a', 'b'], {});
    if (!claim.acquired) throw new Error('not claimed');
    const heartbeat = store.hold(() => ['a', 'b'], claim.token, undefined, { since: claim.claimedAt });

    await expect(heartbeat.confirm()).resolves.toBe(true);
    expect(heartbeat.lost).toBe(false);

    rows.set('b', { ...rows.get('b')!, token: 'other-process' });
    await expect(heartbeat.confirm()).resolves.toBe(false);
    expect(heartbeat.lost).toBe(true);
    expect(heartbeat.signal.reason).toMatchObject({ keys: ['b'], kind: 'taken-over' });
    heartbeat.stop();
  });

  // rc.11 data review F6: expiry came from each process's clock, so a process
  // whose clock ran ahead by more than the TTL took over a live lease.
  it('writes and compares expiry on the database clock, whatever the process clock says', async () => {
    let databaseNow = Date.parse('2026-09-26T12:00:00Z');
    const { db, rows } = createFakeOperationLeaseDb({ now: () => databaseNow });
    const processA = new OperationLeaseStore(db, { ttlMs: 60_000 });
    const processB = new OperationLeaseStore(db, { ttlMs: 60_000 });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // A's clock runs ten minutes behind the database's; B's ten minutes ahead.
      vi.setSystemTime(databaseNow - 10 * 60_000);
      const claim = await processA.claim(['k'], { by: 'a' });
      if (!claim.acquired) throw new Error('not claimed');
      expect(rows.get('k')!.expiresAt.getTime()).toBe(databaseNow + 60_000);

      vi.setSystemTime(databaseNow + 10 * 60_000);
      await expect(processB.claim(['k'], { by: 'b' })).resolves.toMatchObject({
        acquired: false,
        lease: { live: true, data: { by: 'a' } },
      });
      await expect(processB.read('k')).resolves.toMatchObject({ live: true });

      // Only the database clock passing the expiry ends the lease, even for a
      // process whose clock says it is still far off.
      databaseNow += 61_000;
      vi.setSystemTime(databaseNow - 10 * 60_000);
      await expect(processB.read('k')).resolves.toMatchObject({ live: false });
      const taken = await processB.claim(['k'], { by: 'b' });
      if (!taken.acquired) throw new Error('not taken over');

      // A finished outcome is retained for its time on the database clock too.
      await processB.release(['k'], taken.token, { data: { outcome: 'done' }, retainMs: 5_000 });
      expect(rows.get('k')!.expiresAt.getTime()).toBe(databaseNow + 5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the holder, this process unless the caller names one', async () => {
    const { db, rows } = createFakeOperationLeaseDb();
    const store = new OperationLeaseStore(db);
    await store.claim(['a'], {});
    await store.claim(['b'], {}, { holder: 'component-1' });

    expect(rows.get('a')!.holder).toBe(OPERATION_LEASE_PROCESS);
    expect(rows.get('b')!.holder).toBe('component-1');
  });

  it('hashes long keys', () => {
    expect(operationLeaseKey('acme', 'cert:1')).toBe('acme:cert:1');
    expect(operationLeaseKey('acme', 'x'.repeat(300)).length).toBeLessThanOrEqual(255);
  });
});
