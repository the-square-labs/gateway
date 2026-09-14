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
      { mountPoint: '/', totalBytes: 100, usedBytes: 40, freeBytes: 60 },
      { mountPoint: '/data', totalBytes: 1000, usedBytes: 400, freeBytes: 600 },
    ],
    diskFreeBytes: 600,
    swapTotalBytes: 2048,
    swapUsedBytes: 512,
    ...overrides,
  },
});

const member = (nodeId: string, containerName: string) => ({ nodeId, containerName });

describe('buildManagedStorageMetrics', () => {
  it('reads container metrics for the member container', () => {
    const metrics = buildManagedStorageMetrics([node('n1')], [member('n1', 'gateway-storage-c1-0')]);
    expect(metrics.cpu_pct).toBe(12.5);
    expect(metrics.memory_used_bytes).toBe(200 * 1024 * 1024);
    expect(metrics.memory_limit_bytes).toBe(1024 * 1024 * 1024);
    expect(metrics.network_rx_bytes).toBe(1000);
    expect(metrics.network_tx_bytes).toBe(2000);
  });

  it('uses the largest mount as the cluster disk', () => {
    const metrics = buildManagedStorageMetrics([node('n1')], [member('n1', 'gateway-storage-c1-0')]);
    expect(metrics.disk_used_bytes).toBe(400);
    expect(metrics.disk_free_bytes).toBe(600);
    expect(metrics.disk_total_bytes).toBe(1000);
  });

  it('reports swap from the node', () => {
    const metrics = buildManagedStorageMetrics([node('n1')], [member('n1', 'gateway-storage-c1-0')]);
    expect(metrics.swap_total_bytes).toBe(2048);
    expect(metrics.swap_used_bytes).toBe(512);
  });

  it('sums container metrics across members but counts each node disk once', () => {
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
    });
    const metrics = buildManagedStorageMetrics(
      [multi],
      [member('n1', 'gateway-storage-c1-0'), member('n1', 'gateway-storage-c1-1')]
    );
    expect(metrics.cpu_pct).toBe(15);
    expect(metrics.memory_used_bytes).toBe(150);
    expect(metrics.network_rx_bytes).toBe(4);
    // One node hosts both members, so its disk must not be double counted.
    expect(metrics.disk_used_bytes).toBe(400);
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

  it('falls back to node-level free space when no mounts are reported', () => {
    const noMounts = node('n1', { diskMounts: [], diskFreeBytes: 777 });
    const metrics = buildManagedStorageMetrics([noMounts], [member('n1', 'gateway-storage-c1-0')]);
    expect(metrics.disk_free_bytes).toBe(777);
    expect(metrics.disk_used_bytes).toBeNull();
    expect(metrics.disk_total_bytes).toBeNull();
  });
});
