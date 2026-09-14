import { describe, expect, it, vi } from 'vitest';
import { managedStorageClusters } from '@/db/schema/managed-storage.js';
import { StorageWorkloadStore } from './storage-workload-store.js';

/**
 * Fake drizzle client mirroring the db-double pattern used in
 * `database-workload-store.test.ts`: `.update(table).set(values).where(...).returning()`
 * resolving to a single-row array (or an empty one, to simulate a guard that
 * didn't match), with `set`/`where` exposed so tests can assert on the exact
 * values passed through. Also covers `.select().from().where()` /
 * `.limit()` for `getById`/`listPending`.
 */
function fakeDb(rows: Record<string, unknown>[]) {
  const returning = vi.fn(async () => rows);
  const limit = vi.fn(async () => rows);
  // `where` needs to double as both a chainable step (`.returning()` /
  // `.limit()`, for `claimOperation`/`setStatus`/`setReady`/`clearPending`
  // and `getById`) and, for `listPending`, a thenable that resolves
  // directly to `rows` (mirroring drizzle's query builder, which is
  // awaitable at any step).
  // biome-ignore lint/suspicious/noThenProperty: the fake mirrors drizzle's awaitable query builder, whose `then` is exactly what the code under test uses.
  const where = vi.fn(() => ({ returning, limit, then: (resolve: (rows: unknown) => void) => resolve(rows) }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const from = vi.fn(() => ({ where, limit }));
  const select = vi.fn(() => ({ from }));
  const deleteFn = vi.fn(() => ({ where }));
  const db = { update, select, delete: deleteFn };
  return { db, update, set, where, returning, from, select, limit, delete: deleteFn };
}

const baseRow = {
  id: '55555555-5555-4555-8555-555555555555',
  nodeId: '22222222-2222-4222-8222-222222222222',
  status: 'ready',
  pendingOperation: null,
  updatedById: null,
};

describe('StorageWorkloadStore', () => {
  it('getById selects from managedStorageClusters filtered by id and returns the first row', async () => {
    const { db, select, from, where } = fakeDb([baseRow]);
    const store = new StorageWorkloadStore(db as never);

    const result = await store.getById(baseRow.id);

    expect(select).toHaveBeenCalledWith();
    expect(from).toHaveBeenCalledWith(managedStorageClusters);
    expect(where).toHaveBeenCalledTimes(1);
    expect(result).toEqual(baseRow);
  });

  it('getById returns undefined when no row matches', async () => {
    const { db } = fakeDb([]);
    const store = new StorageWorkloadStore(db as never);

    const result = await store.getById(baseRow.id);

    expect(result).toBeUndefined();
  });

  it('listPending selects from managedStorageClusters filtered by pendingOperation IS NOT NULL', async () => {
    const pending = { ...baseRow, pendingOperation: { id: 'op-1', action: 'create' } };
    const { db, from, where } = fakeDb([pending]);
    const store = new StorageWorkloadStore(db as never);

    const result = await store.listPending();

    expect(from).toHaveBeenCalledWith(managedStorageClusters);
    expect(where).toHaveBeenCalledTimes(1);
    expect(result).toEqual([pending]);
  });

  it('claimOperation issues the status + pending-null guarded update against managedStorageClusters', async () => {
    const claimed = { ...baseRow, status: 'updating', pendingOperation: { id: 'op-1', action: 'update' } };
    const { db, update, set, where } = fakeDb([claimed]);
    const store = new StorageWorkloadStore(db as never);

    const result = await store.claimOperation(
      baseRow.id,
      'ready',
      { id: 'op-1', action: 'update' },
      {
        status: 'updating',
        updatedById: 'user-1',
      }
    );

    expect(update).toHaveBeenCalledWith(managedStorageClusters);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingOperation: { id: 'op-1', action: 'update' },
        lastError: null,
        status: 'updating',
        updatedById: 'user-1',
      })
    );
    // Guarded (status + pendingOperation IS NULL) in the same statement as
    // the claim itself, so exactly one `where` call carries the guard.
    expect(where).toHaveBeenCalledTimes(1);
    expect(result).toEqual(claimed);
  });

  it('claimOperation returns undefined when the guard does not match (already claimed / wrong status)', async () => {
    const { db } = fakeDb([]);
    const store = new StorageWorkloadStore(db as never);

    const result = await store.claimOperation(
      baseRow.id,
      'ready',
      { id: 'op-1', action: 'update' },
      {
        status: 'updating',
        updatedById: 'user-1',
      }
    );

    expect(result).toBeUndefined();
  });

  it('setStatus writes the patch plus a fresh updatedAt unconditionally', async () => {
    const updated = { ...baseRow, status: 'error', lastError: 'boom' };
    const { db, update, set } = fakeDb([updated]);
    const store = new StorageWorkloadStore(db as never);

    const result = await store.setStatus(baseRow.id, { status: 'error', lastError: 'boom' });

    expect(update).toHaveBeenCalledWith(managedStorageClusters);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', lastError: 'boom' }));
    expect(result).toEqual(updated);
  });

  it('setReady writes status: ready and pendingOperation: null by default, merging the given patch', async () => {
    const ready = { ...baseRow, status: 'ready', pendingOperation: null, publishedPort: 9000 };
    const { db, set } = fakeDb([ready]);
    const store = new StorageWorkloadStore(db as never);

    const result = await store.setReady(baseRow.id, { publishedPort: 9000 });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ready', pendingOperation: null, lastError: null, publishedPort: 9000 })
    );
    expect(result).toEqual(ready);
  });

  it('setReady lets the patch override the default status (e.g. to stopped)', async () => {
    const stopped = { ...baseRow, status: 'stopped', pendingOperation: null };
    const { db, set } = fakeDb([stopped]);
    const store = new StorageWorkloadStore(db as never);

    await store.setReady(baseRow.id, { status: 'stopped' });

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped', pendingOperation: null }));
  });

  it('clearPending clears pendingOperation and lastError, merging the given patch', async () => {
    const cleared = { ...baseRow, status: 'ready', pendingOperation: null };
    const { db, set } = fakeDb([cleared]);
    const store = new StorageWorkloadStore(db as never);

    const result = await store.clearPending(baseRow.id, { status: 'ready', updatedById: 'user-1' });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingOperation: null,
        lastError: null,
        status: 'ready',
        updatedById: 'user-1',
      })
    );
    expect(result).toEqual(cleared);
  });

  it('delete removes the row from managedStorageClusters by id', async () => {
    const { db, delete: deleteFn, where } = fakeDb([]);
    const store = new StorageWorkloadStore(db as never);

    await store.delete(baseRow.id);

    expect(deleteFn).toHaveBeenCalledWith(managedStorageClusters);
    expect(where).toHaveBeenCalledTimes(1);
  });
});
