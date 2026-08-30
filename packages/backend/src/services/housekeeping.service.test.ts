import { describe, expect, it, vi } from 'vitest';
import { HousekeepingService } from './housekeeping.service.js';

describe('HousekeepingService system certificate cleanup', () => {
  it('cleans only obsolete unused Gateway connector images on online Docker nodes', async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ id: 'node-1' }]) })),
      })),
    };
    const dockerService = {
      inspectSelf: vi.fn().mockResolvedValue({
        Config: { Image: 'the-square-labs/gateway:v2.10.0-rc.8', Labels: {} },
      }),
    };
    const service = new HousekeepingService(
      db as any,
      dockerService as any,
      {} as any,
      {
        SECURE_LINK_CONNECTOR_IMAGE: 'the-square-labs/gateway/secure-link-connector@sha256:current',
      } as any
    );
    vi.spyOn(service as any, 'dockerRequest').mockResolvedValue({ statusCode: 200, body: '[]' });
    const dockerManagement = {
      listAllImages: vi.fn().mockResolvedValue([
        {
          Id: 'current',
          RepoDigests: ['the-square-labs/gateway/secure-link-connector@sha256:current'],
          Created: 3,
          Containers: 0,
          Size: 10,
        },
        {
          Id: 'rollback',
          RepoDigests: ['the-square-labs/gateway/secure-link-connector@sha256:rollback'],
          Created: 2,
          Containers: 0,
          Size: 20,
        },
        {
          Id: 'obsolete',
          RepoDigests: ['the-square-labs/gateway/secure-link-connector@sha256:obsolete'],
          Created: 1,
          Containers: 0,
          Size: 30,
        },
        { Id: 'user', RepoTags: ['acme/api:old'], Created: 0, Containers: 0, Size: 40 },
      ]),
      removeGatewayInternalImage: vi.fn().mockResolvedValue(undefined),
    };
    service.setDockerManagementService(dockerManagement as any);

    await expect((service as any).pruneDockerImages()).resolves.toEqual({
      itemsCleaned: 1,
      spaceFreedBytes: 30,
    });
    expect(dockerManagement.removeGatewayInternalImage).toHaveBeenCalledWith('node-1', 'obsolete');
  });

  it('still cleans managed-node connector images when local Docker inspection is unavailable', async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ id: 'node-1' }]) })),
      })),
    };
    const service = new HousekeepingService(
      db as any,
      { inspectSelf: vi.fn().mockRejectedValue(new Error('socket unavailable')) } as any,
      {} as any,
      { SECURE_LINK_CONNECTOR_IMAGE: 'connector@sha256:current' } as any
    );
    const dockerManagement = {
      listAllImages: vi.fn().mockResolvedValue([
        {
          Id: 'rollback',
          RepoDigests: ['the-square-labs/gateway/secure-link-connector@sha256:rollback'],
          Created: 2,
          Containers: 0,
          Size: 20,
        },
        {
          Id: 'obsolete',
          RepoDigests: ['the-square-labs/gateway/secure-link-connector@sha256:obsolete'],
          Created: 1,
          Containers: 0,
          Size: 30,
        },
      ]),
      removeGatewayInternalImage: vi.fn().mockResolvedValue(undefined),
    };
    service.setDockerManagementService(dockerManagement as any);

    await expect((service as any).pruneDockerImages()).resolves.toEqual({
      itemsCleaned: 1,
      spaceFreedBytes: 30,
    });
  });

  it('enables every available housekeeping category by default', async () => {
    const where = vi.fn().mockResolvedValue([{ key: 'logging:clickhouse', value: { mode: 'local' } }]);
    const service = new HousekeepingService(
      {
        select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
      } as any,
      {} as any,
      {} as any,
      {} as any
    );

    await expect(service.getConfig()).resolves.toMatchObject({
      enabled: true,
      nginxLogs: { enabled: true },
      auditLog: { enabled: true },
      dismissedAlerts: { enabled: true },
      deliveryLog: { enabled: true },
      structuredLogs: { enabled: true },
      clickHouseInternals: { enabled: true },
      orphanedAIArtifacts: { enabled: true },
      internalRegistry: { enabled: true, retentionSuccessfulArtifacts: 3 },
      orphanedVolumes: { enabled: true },
      dockerPrune: { enabled: true },
      orphanedCerts: { enabled: true },
      acmeCleanup: { enabled: true },
    });
  });

  it('keeps ClickHouse internal-log cleanup off by default for external storage', async () => {
    const where = vi.fn().mockResolvedValue([{ key: 'logging:clickhouse', value: { mode: 'external' } }]);
    const service = new HousekeepingService(
      {
        select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
      } as any,
      {} as any,
      {} as any,
      {} as any
    );

    await expect(service.getConfig()).resolves.toMatchObject({
      structuredLogs: { enabled: true },
      clickHouseInternals: { enabled: false },
      orphanedVolumes: { enabled: true },
    });
  });

  it('limits returned run history to the persisted history cap', async () => {
    const history = Array.from({ length: 25 }, (_, index) => ({ startedAt: `run-${index}` }));
    const limit = vi.fn().mockResolvedValue([{ value: history }]);
    const where = vi.fn(() => ({ limit }));
    const service = new HousekeepingService(
      {
        select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
      } as any,
      {} as any,
      {} as any,
      {} as any
    );

    const result = await service.getRunHistory();

    expect(result).toHaveLength(20);
    expect(result.at(-1)).toEqual({ startedAt: 'run-19' });
  });

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
      internalRegistry: { enabled: true, retentionSuccessfulArtifacts: 3 },
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
      internalRegistry: { enabled: true, retentionSuccessfulArtifacts: 3 },
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

  it('always runs internal registry GC with the configured retention count', async () => {
    const service = new HousekeepingService({} as any, {} as any, {} as any, {} as any);
    const runGarbageCollection = vi.fn().mockResolvedValue({
      progress: { candidateArtifactIds: ['artifact-1', 'artifact-2'] },
    });
    service.setInternalRegistryMaintenanceService({ runGarbageCollection } as any);
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
      internalRegistry: { enabled: true, retentionSuccessfulArtifacts: 5 },
      orphanedVolumes: { enabled: false, retentionDays: 30 },
      dockerPrune: { enabled: false },
      orphanedCerts: { enabled: false },
      acmeCleanup: { enabled: false },
    });
    vi.spyOn(service as any, 'saveRunResult').mockResolvedValue(undefined);

    const result = await service.runAll('manual', 'user-1');

    expect(runGarbageCollection).toHaveBeenCalledWith({
      requestedById: 'user-1',
      retentionCount: 5,
    });
    expect(result.categories).toEqual([
      expect.objectContaining({ category: 'Internal Registry', success: true, itemsCleaned: 2 }),
    ]);
  });
});
