import { describe, expect, it } from 'vitest';
import { buildManagedStorageMetrics, type MetricsNode } from './managed-storage-metrics.js';

const node = (id: string, overrides: Partial<NonNullable<MetricsNode['healthReport']>> = {}): MetricsNode => ({
  id,
  healthReport: {
    containerStats: [
      {
        name: 'gateway-storage-c1-0',
        cpuPercent: 12.5,
        memoryUsageBytes: 200 * 1024 * 1024,
        memoryLimitBytes: 1024 * 1024 * 1024,
        networkRxBytes: 1000,
        networkTxBytes: 2000,
        metricsAvailable: true,
      },
    ],
    diskMounts: [
      { mountPoint: '/', totalBytes: 500, usedBytes: 200, freeBytes: 300 },
      { mountPoint: '/data', totalBytes: 1000, usedBytes: 400, freeBytes: 600 },
      { mountPoint: '/data/storage/mounts/c1-0', totalBytes: 32, usedBytes: 4, freeBytes: 28 },
    ],
    diskFreeBytes: 600,
    swapTotalBytes: 2048,
    swapUsedBytes: 512,
    ...overrides,
  },
});

const member = (nodeId: string, containerName: string) => ({
  nodeId,
  containerName,
  storageMountPathSuffix: `/storage/mounts/${containerName.replace('gateway-storage-', '')}`,
});

describe('buildManagedStorageMetrics', () => {
  it('reads container metrics for the member container', () => {
    const metrics = buildManagedStorageMetrics([node('n1')], [member('n1', 'gateway-storage-c1-0')]);
    expect(metrics.cpu_pct).toBe(12.5);
    expect(metrics.memory_used_bytes).toBe(200 * 1024 * 1024);
    expect(metrics.memory_limit_bytes).toBe(1024 * 1024 * 1024);
    expect(metrics.network_rx_bytes).toBe(1000);
    expect(metrics.network_tx_bytes).toBe(2000);
  });

  it('uses the managed ext4 image instead of a host filesystem', () => {
    const metrics = buildManagedStorageMetrics([node('n1')], [member('n1', 'gateway-storage-c1-0')]);
    expect(metrics.disk_used_bytes).toBe(4);
    expect(metrics.disk_free_bytes).toBe(28);
    expect(metrics.disk_total_bytes).toBe(32);
  });

  it('reports swap from the node', () => {
    const metrics = buildManagedStorageMetrics([node('n1')], [member('n1', 'gateway-storage-c1-0')]);
    expect(metrics.swap_total_bytes).toBe(2048);
    expect(metrics.swap_used_bytes).toBe(512);
  });

  it('sums resource metrics across managed-storage members', () => {
    const multi = node('n1', {
      containerStats: [
        {
          name: 'gateway-storage-c1-0',
          cpuPercent: 10,
          memoryUsageBytes: 100,
          memoryLimitBytes: 500,
          networkRxBytes: 1,
          networkTxBytes: 2,
          metricsAvailable: true,
        },
        {
          name: 'gateway-storage-c1-1',
          cpuPercent: 5,
          memoryUsageBytes: 50,
          memoryLimitBytes: 500,
          networkRxBytes: 3,
          networkTxBytes: 4,
          metricsAvailable: true,
        },
      ],
      diskMounts: [
        { mountPoint: '/data/storage/mounts/c1-0', totalBytes: 32, usedBytes: 4, freeBytes: 28 },
        { mountPoint: '/data/storage/mounts/c1-1', totalBytes: 64, usedBytes: 6, freeBytes: 58 },
      ],
    });
    const metrics = buildManagedStorageMetrics(
      [multi],
      [member('n1', 'gateway-storage-c1-0'), member('n1', 'gateway-storage-c1-1')]
    );
    expect(metrics.cpu_pct).toBe(15);
    expect(metrics.memory_used_bytes).toBe(150);
    expect(metrics.network_rx_bytes).toBe(4);
    expect(metrics.disk_used_bytes).toBe(10);
    expect(metrics.disk_total_bytes).toBe(96);
  });

  // A daemon that cannot sample a metric reports 0. Rendering that as a real
  // measurement is the bug this whole module exists to avoid.
  it('reports null rather than zero when the node has no readings', () => {
    const blind = node('n1', { swapTotalBytes: 0, swapUsedBytes: 0, diskMounts: [], diskFreeBytes: 0 });
    const metrics = buildManagedStorageMetrics([blind], [member('n1', 'gateway-storage-c1-0')]);
    expect(metrics.swap_total_bytes).toBeNull();
    expect(metrics.swap_used_bytes).toBeNull();
    expect(metrics.disk_used_bytes).toBeNull();
    expect(metrics.disk_free_bytes).toBeNull();
  });

  it('skips container stats flagged as unavailable', () => {
    const unsampled = node('n1', {
      containerStats: [{ name: 'gateway-storage-c1-0', cpuPercent: 0, metricsAvailable: false }],
    });
    const metrics = buildManagedStorageMetrics([unsampled], [member('n1', 'gateway-storage-c1-0')]);
    expect(metrics.cpu_pct).toBeNull();
    expect(metrics.memory_used_bytes).toBeNull();
  });

  it('returns nulls when the member container is absent from the report', () => {
    const metrics = buildManagedStorageMetrics([node('n1')], [member('n1', 'gateway-storage-other-0')]);
    expect(metrics.cpu_pct).toBeNull();
    expect(metrics.network_tx_bytes).toBeNull();
  });

  it('returns nulls when the node has no health report at all', () => {
    const metrics = buildManagedStorageMetrics(
      [{ id: 'n1', healthReport: null }],
      [member('n1', 'gateway-storage-c1-0')]
    );
    expect(metrics.cpu_pct).toBeNull();
    expect(metrics.disk_free_bytes).toBeNull();
  });

  it('reports disk metrics as unknown for legacy host-only health data', () => {
    const noMounts = node('n1', { diskMounts: [], diskFreeBytes: 777 });
    const metrics = buildManagedStorageMetrics([noMounts], [member('n1', 'gateway-storage-c1-0')]);
    expect(metrics.disk_free_bytes).toBeNull();
    expect(metrics.disk_used_bytes).toBeNull();
    expect(metrics.disk_total_bytes).toBeNull();
  });
});
