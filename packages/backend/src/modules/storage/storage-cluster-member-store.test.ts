import { asc, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { managedStorageClusterMembers } from '@/db/schema/managed-storage.js';
import { StorageClusterMemberStore } from './storage-cluster-member-store.js';

/**
 * Fake drizzle client mirroring the db-double pattern used in
 * `storage-workload-store.test.ts`: `.select().from().where().orderBy()`
 * for `listByCluster`, `.insert().values().returning()` for
 * `insertMembers`, `.update().set().where()` for `setMemberStatus`, and
 * `.delete().where()` for `deleteByCluster`. Each chainable step is
 * captured via `vi.fn` so tests can assert on the exact arguments passed
 * through, not just the final resolved value.
 */
function fakeDb(rows: Record<string, unknown>[]) {
  const orderBy = vi.fn(async () => rows);
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const returning = vi.fn(async () => rows);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const updateWhere = vi.fn(async () => undefined);
  const set = vi.fn((_values: Record<string, unknown>) => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));
  const deleteWhere = vi.fn(async () => undefined);
  const deleteFn = vi.fn(() => ({ where: deleteWhere }));
  const db = { select, insert, update, delete: deleteFn };
  return {
    db,
    select,
    from,
    where,
    orderBy,
    insert,
    values,
    returning,
    update,
    set,
    updateWhere,
    delete: deleteFn,
    deleteWhere,
  };
}

const clusterId = '11111111-1111-4111-8111-111111111111';

const baseRow = {
  id: '55555555-5555-4555-8555-555555555555',
  clusterId,
  nodeId: '22222222-2222-4222-8222-222222222222',
  memberIndex: 0,
  drives: 4,
  status: 'pending',
  lastError: null,
};

describe('StorageClusterMemberStore', () => {
  it('listByCluster selects from managedStorageClusterMembers filtered by clusterId, ordered by memberIndex ascending', async () => {
    const { db, select, from, where, orderBy } = fakeDb([baseRow]);
    const store = new StorageClusterMemberStore(db as never);

    const result = await store.listByCluster(clusterId);

    expect(select).toHaveBeenCalledWith();
    expect(from).toHaveBeenCalledWith(managedStorageClusterMembers);
    expect(where).toHaveBeenCalledWith(eq(managedStorageClusterMembers.clusterId, clusterId));
    expect(orderBy).toHaveBeenCalledWith(asc(managedStorageClusterMembers.memberIndex));
    expect(result).toEqual([baseRow]);
  });

  it('insertMembers batches all rows into a single insert, tagging each with clusterId, and returns the inserted rows', async () => {
    const inserted = [
      { ...baseRow, memberIndex: 0, nodeId: 'node-a' },
      { ...baseRow, id: 'other-id', memberIndex: 1, nodeId: 'node-b', drives: 2 },
    ];
    const { db, insert, values } = fakeDb(inserted);
    const store = new StorageClusterMemberStore(db as never);

    const result = await store.insertMembers(clusterId, [
      { nodeId: 'node-a', memberIndex: 0, drives: 4 },
      { nodeId: 'node-b', memberIndex: 1, drives: 2 },
    ]);

    expect(insert).toHaveBeenCalledWith(managedStorageClusterMembers);
    expect(values).toHaveBeenCalledWith([
      { clusterId, nodeId: 'node-a', memberIndex: 0, drives: 4 },
      { clusterId, nodeId: 'node-b', memberIndex: 1, drives: 2 },
    ]);
    expect(result).toEqual(inserted);
  });

  it('insertMembers short-circuits to [] without issuing a query when given no members', async () => {
    const { db, insert } = fakeDb([]);
    const store = new StorageClusterMemberStore(db as never);

    const result = await store.insertMembers(clusterId, []);

    expect(insert).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('setMemberStatus updates only the provided fields plus a fresh updatedAt, targeted by id', async () => {
    const { db, update, set, updateWhere } = fakeDb([]);
    const store = new StorageClusterMemberStore(db as never);

    await store.setMemberStatus(baseRow.id, { status: 'ready' });

    expect(update).toHaveBeenCalledWith(managedStorageClusterMembers);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready', updatedAt: expect.any(Date) }));
    const setArg = set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('lastError');
    expect(updateWhere).toHaveBeenCalledWith(eq(managedStorageClusterMembers.id, baseRow.id));
  });

  it('setMemberStatus writes lastError (including explicit null) when provided, without touching status', async () => {
    const { db, set } = fakeDb([]);
    const store = new StorageClusterMemberStore(db as never);

    await store.setMemberStatus(baseRow.id, { lastError: null });

    const setArg = set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('status');
    expect(setArg).toHaveProperty('lastError', null);
  });

  it('setMemberStatus writes both status and lastError when both are provided', async () => {
    const { db, set } = fakeDb([]);
    const store = new StorageClusterMemberStore(db as never);

    await store.setMemberStatus(baseRow.id, { status: 'error', lastError: 'boom' });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', lastError: 'boom', updatedAt: expect.any(Date) })
    );
  });

  it('deleteByCluster removes rows from managedStorageClusterMembers filtered by clusterId', async () => {
    const { db, delete: deleteFn, deleteWhere } = fakeDb([]);
    const store = new StorageClusterMemberStore(db as never);

    await store.deleteByCluster(clusterId);

    expect(deleteFn).toHaveBeenCalledWith(managedStorageClusterMembers);
    expect(deleteWhere).toHaveBeenCalledWith(eq(managedStorageClusterMembers.clusterId, clusterId));
  });
});
