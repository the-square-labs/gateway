import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { OperationLeaseStore, operationLeaseKey } from '@/db/operation-lease.js';
import { createFakeOperationLeaseDb } from '@/db/operation-lease.test-helpers.js';
import { DockerContainerTransitions } from './docker-container-transitions.js';

afterEach(() => {
  vi.useRealTimers();
});

/** One backend process's transition map on a lease database shared with the others. */
function backendProcess(db: DrizzleClient, options?: { ttlMs?: number; heartbeatMs?: number }) {
  const transitions = new DockerContainerTransitions();
  transitions.setLeaseStore(new OperationLeaseStore(db, options));
  return transitions;
}

const leaseKey = operationLeaseKey('docker-container', 'node-1:api');

// rc.11 data review F6: a lost container lease was only logged, and the
// operation kept acting as the owner.
describe('container transition leases that are lost', () => {
  it('confirms a lease it still holds, and refuses once another process took it over', async () => {
    const leaseDb = createFakeOperationLeaseDb();
    const a = backendProcess(leaseDb.db);
    a.set('node-1', 'api', 'updating');
    await a.acquireLeases('node-1', ['api']);
    const { token } = leaseDb.rows.get(leaseKey)!;

    // Asked again before an owner-only step: renewed, still its own.
    await expect(a.acquireLeases('node-1', ['api'])).resolves.toBeUndefined();
    expect(leaseDb.rows.get(leaseKey)!.token).toBe(token);

    // Its lease lapsed and another process claimed the container.
    leaseDb.rows.set(leaseKey, { ...leaseDb.rows.get(leaseKey)!, token: 'replica-2-token' });
    await expect(a.acquireLeases('node-1', ['api'])).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONTAINER_BUSY',
      details: { name: 'api', leaseLost: true },
    });

    // Ending the transition here leaves the other process's lease alone.
    a.clear('node-1', 'api');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(leaseDb.rows.get(leaseKey)).toMatchObject({ token: 'replica-2-token' });
  });

  it('stops renewing a lease another process took over', async () => {
    vi.useFakeTimers();
    const leaseDb = createFakeOperationLeaseDb();
    const a = backendProcess(leaseDb.db, { ttlMs: 3_000, heartbeatMs: 1_000 });
    a.set('node-1', 'api', 'updating');
    await a.acquireLeases('node-1', ['api']);

    leaseDb.rows.set(leaseKey, { ...leaseDb.rows.get(leaseKey)!, token: 'replica-2-token' });
    await vi.advanceTimersByTimeAsync(1_000);
    // The heartbeat that found the takeover was its last renewal.
    const renewals = leaseDb.acquired.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(leaseDb.acquired).toHaveLength(renewals);
    await expect(a.acquireLeases('node-1', ['api'])).rejects.toMatchObject({ details: { leaseLost: true } });
  });

  it('refuses once renewals have failed for a full TTL, without waiting for the database', async () => {
    vi.useFakeTimers();
    const leaseDb = createFakeOperationLeaseDb();
    let databaseDown = false;
    const transaction = leaseDb.db.transaction.bind(leaseDb.db);
    const db = Object.assign(Object.create(leaseDb.db), {
      transaction: (fn: never) => (databaseDown ? Promise.reject(new Error('connection lost')) : transaction(fn)),
    }) as DrizzleClient;
    const a = backendProcess(db, { ttlMs: 3_000, heartbeatMs: 1_000 });
    a.set('node-1', 'api', 'migrating');
    await a.acquireLeases('node-1', ['api']);

    databaseDown = true;
    await vi.advanceTimersByTimeAsync(3_000);
    databaseDown = false;
    // Another process may have owned the container meanwhile: the operation stops.
    await expect(a.acquireLeases('node-1', ['api'])).rejects.toMatchObject({
      code: 'CONTAINER_BUSY',
      details: { leaseLost: true },
    });
  });
});
