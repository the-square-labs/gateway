import { describe, expect, it, vi } from 'vitest';
import { ResourceSnapshotStore } from './resource-snapshot.store.js';

function makeCache() {
  const values = new Map<string, string>();
  const client = {
    mget: vi.fn(async (keys: string[]) => keys.map((key) => values.get(key) ?? null)),
    set: vi.fn(async (key: string, value: string) => {
      if (values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      keys.forEach((key) => {
        values.delete(key);
      });
      return keys.length;
    }),
    eval: vi.fn(async (_script: string, _keys: number, key: string, token: string) => {
      if (values.get(key) !== token) return 0;
      values.delete(key);
      return 1;
    }),
  };
  return {
    get: vi.fn(async <T>(key: string) => {
      const value = values.get(key);
      return value ? (JSON.parse(value) as T) : null;
    }),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, JSON.stringify(value));
    }),
    getClient: () => client,
  };
}

describe('ResourceSnapshotStore', () => {
  it('keeps last-known data when a later refresh fails', async () => {
    const cache = makeCache();
    const store = new ResourceSnapshotStore(cache as never);

    await store.replace('node', 'node-1', { status: 'online' });
    const failed = await store.markError('node', 'node-1', { status: 'unknown' }, new Error('offline'), 'unavailable');

    expect(failed).toMatchObject({
      data: { status: 'online' },
      revision: 1,
      refreshStatus: 'error',
      availability: 'unavailable',
      lastError: 'offline',
    });
  });

  it('marks a refresh without discarding the last successful payload', async () => {
    const cache = makeCache();
    const store = new ResourceSnapshotStore(cache as never);
    await store.replace('node', 'node-1', { status: 'online' });

    const refreshing = await store.markRefreshing('node', 'node-1', { status: 'unknown' });

    expect(refreshing).toMatchObject({
      data: { status: 'online' },
      revision: 1,
      refreshStatus: 'refreshing',
      availability: 'available',
    });
  });

  it('returns only valid snapshots from a batched read', async () => {
    const cache = makeCache();
    const store = new ResourceSnapshotStore(cache as never);
    await store.replace('proxy', 'one', { enabled: true });

    const snapshots = await store.getMany<{ enabled: boolean }>('proxy', ['one', 'missing', 'one']);

    expect(snapshots.get('one')?.data).toEqual({ enabled: true });
    expect(snapshots.has('missing')).toBe(false);
  });

  it('does not run work without the per-resource refresh lease', async () => {
    const cache = makeCache();
    const store = new ResourceSnapshotStore(cache as never);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = vi.fn(async () => {
      await hold;
      return 'fresh';
    });

    const firstPromise = store.withLease('docker', 'node-1', work);
    await vi.waitFor(() => expect(work).toHaveBeenCalledOnce());
    const second = await store.withLease('docker', 'node-1', work);
    release();
    const first = await firstPromise;

    expect(first).toEqual({ acquired: true, value: 'fresh' });
    expect(second).toEqual({ acquired: false });
    expect(work).toHaveBeenCalledTimes(1);
  });
});
