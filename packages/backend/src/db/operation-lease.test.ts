import { describe, expect, it, vi } from 'vitest';
import { OPERATION_LEASE_PROCESS, OperationLeaseStore, operationLeaseKey } from './operation-lease.js';
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
      const heartbeat = store.hold(() => ['k'], claim.token, lost);
      const expiry = () => rows.get('k')!.expiresAt.getTime();
      const before = expiry();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(expiry()).toBeGreaterThan(before);
      expect(lost).not.toHaveBeenCalled();

      rows.set('k', { ...rows.get('k')!, token: 'other-process' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(lost).toHaveBeenCalledWith('k');
      heartbeat.stop();
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
