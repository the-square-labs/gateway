import { describe, expect, it, vi } from 'vitest';
import { HousekeepingService } from './housekeeping.service.js';

describe('HousekeepingService system certificate cleanup', () => {
  it('uses the fixed 30-day lifecycle key-retention policy', async () => {
    const service = new HousekeepingService({} as any, {} as any, {} as any, {} as any);
    const destroyRetiredPrivateKeys = vi.fn().mockResolvedValue(3);
    service.setSystemCertificateLifecycleService({ destroyRetiredPrivateKeys } as any);

    await expect((service as any).cleanOrphanedCerts()).resolves.toEqual({ itemsCleaned: 3 });
    expect(destroyRetiredPrivateKeys).toHaveBeenCalledWith(30);
  });

  it('runs enabled ClickHouse internal-log cleanup during a manual run', async () => {
    const service = new HousekeepingService({} as any, {} as any, {} as any, {} as any);
    const cleanupInternalLogsAndRefresh = vi.fn().mockResolvedValue({ itemsCleaned: 42, spaceFreedBytes: 1024 });
    service.setLoggingMaintenanceService({ cleanupInternalLogsAndRefresh } as any);
    vi.spyOn(service, 'getConfig').mockResolvedValue({
      enabled: true,
      cronExpression: '0 2 * * *',
      nginxLogs: { enabled: false, retentionDays: 30 },
      auditLog: { enabled: false, retentionDays: 90 },
      dismissedAlerts: { enabled: false, retentionDays: 30 },
      deliveryLog: { enabled: false, retentionDays: 7 },
      structuredLogs: { enabled: false, maxRows: 100_000, maxSizeBytes: 10 * 1024 ** 3 },
      clickHouseInternals: { enabled: true, maxSizeBytes: 512 * 1024 ** 2 },
      orphanedAIArtifacts: { enabled: false },
      gatewayLogs: { enabled: false },
      orphanedVolumes: { enabled: false, retentionDays: 30 },
      dockerPrune: { enabled: false },
      orphanedCerts: { enabled: false },
      acmeCleanup: { enabled: false },
    });
    vi.spyOn(service as any, 'saveRunResult').mockResolvedValue(undefined);

    const result = await service.runAll('manual');

    expect(cleanupInternalLogsAndRefresh).toHaveBeenCalledWith(undefined, {
      enabled: true,
      maxSizeBytes: 512 * 1024 ** 2,
    });
    expect(result.categories).toEqual([
      expect.objectContaining({
        category: 'ClickHouse Internals',
        success: true,
        itemsCleaned: 42,
        spaceFreedBytes: 1024,
      }),
    ]);
  });

  it('runs Pages maintenance as a first-class housekeeping category', async () => {
    const service = new HousekeepingService({} as any, {} as any, {} as any, {} as any);
    const run = vi.fn().mockResolvedValue({ itemsCleaned: 2, spaceFreedBytes: 4096 });
    service.setPagesMaintenanceService({ run });
    vi.spyOn(service, 'getConfig').mockResolvedValue({
      enabled: true,
      cronExpression: '0 2 * * *',
      nginxLogs: { enabled: false, retentionDays: 30 },
      auditLog: { enabled: false, retentionDays: 90 },
      dismissedAlerts: { enabled: false, retentionDays: 30 },
      deliveryLog: { enabled: false, retentionDays: 7 },
      structuredLogs: { enabled: false, maxRows: 100_000, maxSizeBytes: 10 * 1024 ** 3 },
      clickHouseInternals: { enabled: false, maxSizeBytes: 512 * 1024 ** 2 },
      orphanedAIArtifacts: { enabled: false },
      gatewayLogs: { enabled: false },
      orphanedVolumes: { enabled: false, retentionDays: 30 },
      dockerPrune: { enabled: false },
      orphanedCerts: { enabled: false },
      acmeCleanup: { enabled: false },
    });
    vi.spyOn(service as any, 'saveRunResult').mockResolvedValue(undefined);

    const result = await service.runAll('manual');

    expect(run).toHaveBeenCalledOnce();
    expect(result.categories).toEqual([
      expect.objectContaining({ category: 'Pages', itemsCleaned: 2, spaceFreedBytes: 4096 }),
    ]);
  });
});
