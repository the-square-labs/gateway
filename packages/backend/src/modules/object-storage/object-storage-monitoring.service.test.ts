import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CacheService } from '@/services/cache.service.js';
import type { ManagedStorageMetricsProvider } from './managed-storage-metrics-provider.js';
import type { ObjectStorageConnectionView, ObjectStorageService } from './object-storage.service.js';
import { ObjectStorageMonitoringService } from './object-storage-monitoring.service.js';

const connection = {
  id: 's1',
  name: 'Storage',
  provider: 'minio',
  healthStatus: 'online',
  managed: { id: 'm1' },
} as ObjectStorageConnectionView;
const instances: ObjectStorageMonitoringService[] = [];

function setup(history: unknown[] = [], metrics: Record<string, number | null> = { cpu_pct: 12 }) {
  const storage = {
    get: vi.fn().mockResolvedValue(connection),
    listAllRows: vi.fn().mockResolvedValue([{ id: 's1' }]),
    listBuckets: vi.fn().mockResolvedValue([]),
    updateHealth: vi.fn().mockResolvedValue(undefined),
  };
  const redis = {
    lrange: vi.fn().mockResolvedValue(history.map((entry) => JSON.stringify(entry))),
    lpush: vi.fn(),
    ltrim: vi.fn(),
    expire: vi.fn(),
  };
  const provider = {
    getMetrics: vi.fn().mockResolvedValue(metrics),
    getSnapshot: vi
      .fn<() => Promise<{ timestamp: string | null; metrics: Record<string, number | null> }>>()
      .mockResolvedValue({ timestamp: '2026-09-16T00:00:00.000Z', metrics }),
  };
  const monitoring = new ObjectStorageMonitoringService(
    storage as unknown as ObjectStorageService,
    { getClient: () => redis } as unknown as CacheService,
    provider as unknown as ManagedStorageMetricsProvider
  );
  instances.push(monitoring);
  return { storage, redis, provider, monitoring };
}

afterEach(() => {
  for (const instance of instances.splice(0)) instance.destroy();
  vi.useRealTimers();
});

describe('Storage snapshot-first monitoring', () => {
  it.each([
    null,
    'invalid',
    '2026-09-15T23:58:59.000Z',
    '2026-09-16T00:00:01.000Z',
  ])('does not present stale or unverified resource data as live (%s)', async (timestamp) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T00:00:00.000Z'));
    const { monitoring, provider, redis, storage } = setup();
    provider.getSnapshot.mockResolvedValue({ timestamp, metrics: { cpu_pct: 12, disk_total_bytes: 64000 } });
    monitoring.registerClient('s1');
    await vi.advanceTimersByTimeAsync(0);
    const snapshot = JSON.parse(redis.lpush.mock.calls[0]![1]);
    expect(snapshot.status).toBe('online');
    expect(snapshot.metrics).toEqual({ cpu_pct: null, disk_total_bytes: null, latency_ms: 0, bucket_count: 0 });
    expect(storage.updateHealth).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'online' }));
  });

  it('expires stopped heartbeat metrics while S3 stays healthy and recovers on a fresh report', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T00:00:00.000Z'));
    const { monitoring, provider, redis } = setup();
    monitoring.registerClient('s1');
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(redis.lpush.mock.calls.at(-1)![1]).metrics.cpu_pct).toBe(12);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(JSON.parse(redis.lpush.mock.calls.at(-1)![1]).metrics.cpu_pct).toBeNull();
    provider.getSnapshot.mockResolvedValue({ timestamp: new Date().toISOString(), metrics: { cpu_pct: 25 } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(JSON.parse(redis.lpush.mock.calls.at(-1)![1]).metrics.cpu_pct).toBe(25);
    expect(provider.getMetrics).not.toHaveBeenCalled();
  });

  it('returns retained history without querying the runtime or S3', async () => {
    const snapshot = { storageId: 's1', metrics: { cpu_pct: 10 } };
    const { monitoring, storage, provider } = setup([snapshot]);
    expect(await monitoring.getInitialHistory(connection)).toEqual([snapshot]);
    expect(storage.listBuckets).not.toHaveBeenCalled();
    expect(provider.getMetrics).not.toHaveBeenCalled();
    expect(provider.getSnapshot).not.toHaveBeenCalled();
  });

  it('seeds a cold cache from persisted node reports without waiting for S3', async () => {
    const { monitoring, storage } = setup();
    storage.listBuckets.mockImplementation(() => new Promise(() => {}));
    expect(await monitoring.getInitialHistory(connection)).toEqual([
      expect.objectContaining({
        timestamp: '2026-09-16T00:00:00.000Z',
        status: 'online',
        metrics: { cpu_pct: 12, latency_ms: null, bucket_count: null },
      }),
    ]);
    expect(storage.listBuckets).not.toHaveBeenCalled();
  });

  it('does not invent metrics for external or unobserved storage', async () => {
    const { monitoring, provider } = setup([], { cpu_pct: null });
    expect(await monitoring.getInitialHistory(connection)).toEqual([]);
    expect(await monitoring.getInitialHistory({ ...connection, managed: undefined })).toEqual([]);
    expect(provider.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it('starts background sampling after startup delay, not one minute later', async () => {
    vi.useFakeTimers();
    const { storage } = setup();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(storage.listAllRows).toHaveBeenCalledTimes(1);
    expect(storage.listBuckets).toHaveBeenCalledTimes(1);
  });

  it('coalesces slow active/background polls and allows the next poll after completion', async () => {
    vi.useFakeTimers();
    const { monitoring, storage } = setup();
    let resolve!: (value: []) => void;
    storage.listBuckets.mockImplementationOnce(
      () =>
        new Promise<[]>((done) => {
          resolve = done;
        })
    );
    monitoring.registerClient('s1');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(storage.listBuckets).toHaveBeenCalledTimes(1);
    resolve([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(storage.listBuckets).toHaveBeenCalledTimes(2);
    monitoring.unregisterClient('s1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(storage.listBuckets).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight guard after a failed poll', async () => {
    vi.useFakeTimers();
    const { monitoring, storage } = setup();
    storage.listBuckets.mockRejectedValueOnce(new Error('socket closed'));
    monitoring.registerClient('s1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(storage.listBuckets).toHaveBeenCalledTimes(2);
  });
});
