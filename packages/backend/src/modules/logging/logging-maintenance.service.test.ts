import { describe, expect, it, vi } from 'vitest';
import type { LoggingClickHouseService } from './logging-clickhouse.service.js';
import { LoggingFeatureService } from './logging-feature.service.js';
import { CLICKHOUSE_INTERNAL_LOG_CAP_BYTES, LoggingMaintenanceService } from './logging-maintenance.service.js';

function feature() {
  return new LoggingFeatureService({ isConfigured: () => true });
}

function storage(overrides: Record<string, unknown> = {}) {
  return {
    isConfigured: vi.fn().mockReturnValue(true),
    ping: vi.fn().mockResolvedValue(true),
    structuredTableExists: vi.fn().mockResolvedValue(true),
    getStorageStats: vi.fn().mockResolvedValue({
      structuredRows: 100,
      structuredBytes: 1000,
      internalRows: 100,
      internalBytes: 1000,
      diskTotalBytes: 100 * 1024 ** 3,
      diskFreeBytes: 80 * 1024 ** 3,
    }),
    listStructuredPartitions: vi.fn().mockResolvedValue([]),
    dropStructuredPartition: vi.fn().mockResolvedValue(undefined),
    flushSystemLogs: vi.fn().mockResolvedValue(undefined),
    listInternalLogTables: vi.fn().mockResolvedValue([]),
    cleanInternalLogTable: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as LoggingClickHouseService;
}

describe('LoggingMaintenanceService', () => {
  it('publishes a health event when the effective status changes', async () => {
    const eventBus = { publish: vi.fn() };
    const service = new LoggingMaintenanceService(storage(), feature());
    service.setEventBus(eventBus as any);

    await service.runGuard();

    expect(eventBus.publish).toHaveBeenCalledWith(
      'logging.health.changed',
      expect.objectContaining({ status: 'healthy' })
    );
  });

  it('keeps storage available when metrics are unavailable after a successful ping', async () => {
    const storageService = storage({
      getStorageStats: vi.fn().mockRejectedValue(new Error('system.parts denied')),
    });
    const featureService = feature();
    const service = new LoggingMaintenanceService(storageService, featureService);

    await expect(service.runGuard()).resolves.toMatchObject({ status: 'degraded' });
    expect(featureService.isAvailable()).toBe(true);
    expect(featureService.getStatus().capacityExhausted).toBe(false);
  });

  it('preserves a confirmed capacity gate when a later metrics read fails', async () => {
    const getStorageStats = vi
      .fn()
      .mockResolvedValueOnce({
        structuredRows: 100,
        structuredBytes: 1000,
        internalRows: 100,
        internalBytes: 1000,
        diskTotalBytes: 100 * 1024 ** 3,
        diskFreeBytes: 512 * 1024 ** 2,
      })
      .mockRejectedValueOnce(new Error('system.disks denied'));
    const featureService = feature();
    const service = new LoggingMaintenanceService(storage({ getStorageStats }), featureService);

    await expect(service.runGuard()).resolves.toMatchObject({ status: 'exhausted' });
    expect(featureService.getStatus().capacityExhausted).toBe(true);
    await expect(service.runGuard()).resolves.toMatchObject({ status: 'degraded' });
    expect(featureService.getStatus().capacityExhausted).toBe(true);
  });

  it('marks storage unavailable only after two consecutive ping failures', async () => {
    const storageService = storage({ ping: vi.fn().mockResolvedValue(false) });
    const featureService = feature();
    featureService.markAvailable();
    const service = new LoggingMaintenanceService(storageService, featureService);

    await expect(service.runGuard()).resolves.toMatchObject({ status: 'degraded' });
    expect(featureService.isAvailable()).toBe(true);
    await expect(service.runGuard()).resolves.toMatchObject({ status: 'unavailable' });
    expect(featureService.isAvailable()).toBe(false);
  });

  it('does not recover availability when the structured log table is missing', async () => {
    const storageService = storage({ structuredTableExists: vi.fn().mockResolvedValue(false) });
    const featureService = feature();
    const service = new LoggingMaintenanceService(storageService, featureService);

    await expect(service.runGuard()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'ClickHouse structured log table is unavailable',
    });
    expect(featureService.isAvailable()).toBe(false);
  });

  it('cleans high-volume internal logs down to the safety target', async () => {
    const getStorageStats = vi
      .fn()
      .mockResolvedValueOnce({
        structuredRows: 100,
        structuredBytes: 1000,
        internalRows: 1_000_000,
        internalBytes: CLICKHOUSE_INTERNAL_LOG_CAP_BYTES * 2,
        diskTotalBytes: 100 * 1024 ** 3,
        diskFreeBytes: 80 * 1024 ** 3,
      })
      .mockResolvedValueOnce({
        structuredRows: 100,
        structuredBytes: 1000,
        internalRows: 100,
        internalBytes: 32 * 1024 ** 2,
        diskTotalBytes: 100 * 1024 ** 3,
        diskFreeBytes: 80 * 1024 ** 3,
      });
    const cleanInternalLogTable = vi.fn().mockResolvedValue(undefined);
    const storageService = storage({
      getStorageStats,
      listInternalLogTables: vi.fn().mockResolvedValue([
        { table: 'trace_log', rows: 900_000, bytes: CLICKHOUSE_INTERNAL_LOG_CAP_BYTES * 1.5 },
        { table: 'query_log', rows: 100_000, bytes: CLICKHOUSE_INTERNAL_LOG_CAP_BYTES * 0.5 },
      ]),
      cleanInternalLogTable,
    });
    const service = new LoggingMaintenanceService(storageService, feature());

    await expect(
      service.runGuard(undefined, { enabled: true, maxSizeBytes: CLICKHOUSE_INTERNAL_LOG_CAP_BYTES })
    ).resolves.toMatchObject({ status: 'healthy' });
    expect(cleanInternalLogTable).toHaveBeenCalledWith('trace_log');
    expect(cleanInternalLogTable).not.toHaveBeenCalledWith('query_log');
  });

  it('keeps remote ClickHouse internal logs monitor-only by default', async () => {
    const cleanInternalLogTable = vi.fn().mockResolvedValue(undefined);
    const storageService = storage({
      getStorageStats: vi.fn().mockResolvedValue({
        structuredRows: 100,
        structuredBytes: 1000,
        internalRows: 1_000_000,
        internalBytes: CLICKHOUSE_INTERNAL_LOG_CAP_BYTES * 2,
        diskTotalBytes: 100 * 1024 ** 3,
        diskFreeBytes: 80 * 1024 ** 3,
      }),
      listInternalLogTables: vi
        .fn()
        .mockResolvedValue([{ table: 'query_log', rows: 1_000_000, bytes: CLICKHOUSE_INTERNAL_LOG_CAP_BYTES * 2 }]),
      cleanInternalLogTable,
    });
    const service = new LoggingMaintenanceService(storageService, feature());

    await expect(service.runGuard()).resolves.toMatchObject({ status: 'pressure' });
    expect(cleanInternalLogTable).not.toHaveBeenCalled();
  });

  it('reports internal-table cleanup to a manual Housekeeping run', async () => {
    const cleanInternalLogTable = vi.fn().mockResolvedValue(undefined);
    const storageService = storage({
      getStorageStats: vi
        .fn()
        .mockResolvedValueOnce({
          structuredRows: 100,
          structuredBytes: 1000,
          internalRows: 1_000_000,
          internalBytes: CLICKHOUSE_INTERNAL_LOG_CAP_BYTES * 2,
          diskTotalBytes: 100 * 1024 ** 3,
          diskFreeBytes: 80 * 1024 ** 3,
        })
        .mockResolvedValueOnce({
          structuredRows: 100,
          structuredBytes: 1000,
          internalRows: 42,
          internalBytes: 32 * 1024 ** 2,
          diskTotalBytes: 100 * 1024 ** 3,
          diskFreeBytes: 80 * 1024 ** 3,
        }),
      listInternalLogTables: vi
        .fn()
        .mockResolvedValue([{ table: 'trace_log', rows: 42, bytes: CLICKHOUSE_INTERNAL_LOG_CAP_BYTES }]),
      cleanInternalLogTable,
    });
    const service = new LoggingMaintenanceService(storageService, feature());
    const eventBus = { publish: vi.fn() };
    service.setEventBus(eventBus as any);

    await expect(service.runGuard()).resolves.toMatchObject({ status: 'pressure' });
    eventBus.publish.mockClear();

    await expect(service.cleanupInternalLogsAndRefresh()).resolves.toEqual({
      itemsCleaned: 42,
      spaceFreedBytes: CLICKHOUSE_INTERNAL_LOG_CAP_BYTES,
    });
    expect(cleanInternalLogTable).toHaveBeenCalledWith('trace_log');
    expect(eventBus.publish).toHaveBeenCalledWith(
      'logging.health.changed',
      expect.objectContaining({ status: 'healthy' })
    );
  });

  it('cleans versioned query-log tables only after other internal logs', async () => {
    const cleanInternalLogTable = vi.fn().mockResolvedValue(undefined);
    const service = new LoggingMaintenanceService(
      storage({
        listInternalLogTables: vi.fn().mockResolvedValue([
          { table: 'query_log_0', rows: 5, bytes: CLICKHOUSE_INTERNAL_LOG_CAP_BYTES * 0.2 },
          { table: 'trace_log', rows: 20, bytes: CLICKHOUSE_INTERNAL_LOG_CAP_BYTES * 0.8 },
        ]),
        cleanInternalLogTable,
      }),
      feature()
    );

    await service.cleanupInternalLogsAndRefresh();

    expect(cleanInternalLogTable).toHaveBeenCalledWith('trace_log');
    expect(cleanInternalLogTable).not.toHaveBeenCalledWith('query_log_0');
  });

  it('drops oldest structured partitions while preserving the newest partition', async () => {
    const dropStructuredPartition = vi.fn().mockResolvedValue(undefined);
    const storageService = storage({
      listStructuredPartitions: vi.fn().mockResolvedValue([
        { partition: '2026-07-01', rows: 600, bytes: 600 },
        { partition: '2026-07-02', rows: 300, bytes: 300 },
        { partition: '2026-07-03', rows: 300, bytes: 300 },
      ]),
      dropStructuredPartition,
    });
    const service = new LoggingMaintenanceService(storageService, feature());

    await expect(service.cleanupStructuredLogs({ enabled: true, maxRows: 1000, maxSizeBytes: 1000 })).resolves.toEqual({
      itemsCleaned: 600,
      spaceFreedBytes: 600,
    });
    expect(dropStructuredPartition).toHaveBeenCalledTimes(1);
    expect(dropStructuredPartition).toHaveBeenCalledWith('2026-07-01');
    expect(dropStructuredPartition).not.toHaveBeenCalledWith('2026-07-03');
  });

  it('serializes manual structured cleanup with guard refreshes', async () => {
    let releaseDrop: (() => void) | undefined;
    const dropBlocked = new Promise<void>((resolve) => {
      releaseDrop = resolve;
    });
    const dropStructuredPartition = vi.fn().mockImplementation(() => dropBlocked);
    const listStructuredPartitions = vi
      .fn()
      .mockResolvedValueOnce([
        { partition: '2026-07-01', rows: 900, bytes: 900 },
        { partition: '2026-07-02', rows: 300, bytes: 300 },
      ])
      .mockResolvedValueOnce([{ partition: '2026-07-02', rows: 300, bytes: 300 }]);
    const service = new LoggingMaintenanceService(
      storage({ listStructuredPartitions, dropStructuredPartition }),
      feature()
    );
    const policy = { enabled: true, maxRows: 1000, maxSizeBytes: 10_000 };

    const firstCleanup = service.cleanupStructuredLogsAndRefresh(policy);
    await vi.waitFor(() => expect(dropStructuredPartition).toHaveBeenCalledTimes(1));
    const secondCleanup = service.cleanupStructuredLogsAndRefresh(policy);
    await Promise.resolve();

    expect(listStructuredPartitions).toHaveBeenCalledTimes(1);
    releaseDrop?.();
    await expect(Promise.all([firstCleanup, secondCleanup])).resolves.toEqual([
      { itemsCleaned: 900, spaceFreedBytes: 900 },
      { itemsCleaned: 0, spaceFreedBytes: 0 },
    ]);
    expect(dropStructuredPartition).toHaveBeenCalledTimes(1);
  });
});
