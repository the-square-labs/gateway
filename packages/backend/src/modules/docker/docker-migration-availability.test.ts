import { afterEach, describe, expect, it, vi } from 'vitest';
import { dockerAvailabilityPlacements } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { DockerWorkloadResolverService } from './availability/docker-workload-resolver.service.js';
import type { DockerMigrationPreflightInput } from './docker-migration.schemas.js';
import { DockerMigrationService } from './docker-migration.service.js';
import {
  assertMigrationAvailabilityAllowed,
  MIGRATION_AVAILABILITY_ENABLED,
  migrationAvailabilityBlocker,
} from './docker-migration-availability.js';
import { DockerMigrationExecutor } from './docker-migration-executor.js';
import { DockerMigrationPreflightService } from './docker-migration-preflight.js';
import type { MigrationRow } from './docker-migration-runtime.js';

const input: DockerMigrationPreflightInput = {
  sourceNodeId: 'source',
  targetNodeId: 'target',
  keepSource: false,
  resource: { type: 'container', containerName: 'api' },
};
const row = {
  id: 'migration',
  resourceType: 'container',
  resourceName: 'api',
  sourceNodeId: 'source',
  targetNodeId: 'target',
  phase: 'preparing',
} as MigrationRow;

function database(placements: Array<{ runtimeIdentity: Record<string, unknown> }> = []) {
  return {
    transaction: vi.fn(),
    select: vi.fn(() => {
      let table: unknown;
      const query: any = {
        from: vi.fn((value) => {
          table = value;
          return query;
        }),
        innerJoin: vi.fn(() => query),
        where: vi.fn(() => query),
        limit: vi.fn(async () => []),
        // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
        then: (resolve: (rows: unknown[]) => unknown) =>
          Promise.resolve(table === dockerAvailabilityPlacements ? placements : []).then(resolve),
      };
      return query;
    }),
  };
}

function policy(mode: 'single' | 'replicated' | 'failover' | null) {
  return vi
    .spyOn(DockerWorkloadResolverService.prototype, 'findPolicy')
    .mockResolvedValue(mode ? ({ mode } as never) : null);
}

function preflight(db: ReturnType<typeof database>) {
  const docker = {
    inspectContainer: vi.fn().mockResolvedValue({
      Id: 'container-id',
      scopeResourceId: 'api',
      Image: 'image',
      State: { Status: 'exited' },
      Config: {},
      HostConfig: {},
    }),
    listVolumes: vi.fn().mockResolvedValue([]),
    listNetworks: vi.fn().mockResolvedValue([]),
    listImages: vi.fn().mockResolvedValue([{ Id: 'image', Size: 1024 }]),
    listAllContainers: vi.fn().mockResolvedValue([]),
  };
  const deployments = {
    get: vi.fn().mockResolvedValue({
      id: 'deployment',
      name: 'api',
      status: 'stopped',
      slots: [],
      desiredConfig: { image: 'image' },
    }),
  };
  const dispatch = {
    capabilities: vi.fn().mockResolvedValue({
      osType: 'linux',
      architecture: 'amd64',
      storageDriver: 'overlay2',
      apiVersion: '1.47',
      engineVersion: '27.0.0',
      dockerRootDir: { freeBytes: 10_000_000_000 },
      stateDir: { freeBytes: 10_000_000_000 },
    }),
  };
  const service = new DockerMigrationPreflightService(
    db as never,
    docker as never,
    deployments as never,
    dispatch as never
  );
  service.setLicensePolicyService({ requireFeature: vi.fn() } as never);
  vi.spyOn(service as any, 'getDockerNode').mockImplementation(async (id) => ({
    id,
    slug: id,
    status: 'online',
    capabilities: { dockerMigrationV1: true },
  }));
  return service;
}

afterEach(() => vi.restoreAllMocks());

describe('migration Availability ownership guard', () => {
  it.each(['replicated', 'failover'] as const)('blocks logical containers and deployments in %s mode', async (mode) => {
    const find = policy(mode);
    const db = database();
    for (const resource of [input.resource, { type: 'deployment', deploymentId: 'deployment' } as const]) {
      await expect(migrationAvailabilityBlocker(db as never, { ...input, resource })).resolves.toMatchObject({
        code: MIGRATION_AVAILABILITY_ENABLED,
      });
    }
    expect(find).toHaveBeenCalledWith({ type: 'container', nodeId: 'source', containerName: 'api' });
    expect(find).toHaveBeenCalledWith({ type: 'deployment', deploymentId: 'deployment' });
  });

  it.each([null, 'single'] as const)('allows resources with policy %s', async (mode) => {
    policy(mode);
    await expect(assertMigrationAvailabilityAllowed(database() as never, row)).resolves.toBeUndefined();
  });

  it.each([
    { containerId: '581e545ce348aabbccdd' },
    { containerName: '581e545ce348' },
    { slots: { blue: '581e545ce348aabbccdd' } },
    { routerName: '/581e545ce348' },
    { containers: [{ containerId: '581e545ce348aabbccdd', serviceName: 'api' }] },
  ])('blocks physical container identity %j', async (runtimeIdentity) => {
    policy(null);
    await expect(
      migrationAvailabilityBlocker(database([{ runtimeIdentity }]) as never, {
        ...input,
        resource: { type: 'container', containerName: '/581e545ce348' },
      })
    ).resolves.toMatchObject({ code: MIGRATION_AVAILABILITY_ENABLED });
  });

  it('blocks physical deployment IDs and leaves unrelated names migratable', async () => {
    policy(null);
    const db = database([{ runtimeIdentity: { deploymentId: 'physical', routerName: 'physical-router' } }]);
    await expect(
      migrationAvailabilityBlocker(db as never, {
        ...input,
        resource: { type: 'deployment', deploymentId: 'physical' },
      })
    ).resolves.toMatchObject({ code: MIGRATION_AVAILABILITY_ENABLED });
    await expect(migrationAvailabilityBlocker(db as never, input)).resolves.toBeNull();
  });

  it('fails closed when the ownership lookup fails', async () => {
    policy(null).mockRejectedValue(new Error('database unavailable'));
    await expect(assertMigrationAvailabilityAllowed(database() as never, row)).rejects.toThrow('database unavailable');
  });
});

describe('migration Availability enforcement boundaries', () => {
  it.each([
    'container',
    'deployment',
  ] as const)('returns preflight blockers and rejects create for HA %s', async (type) => {
    const find = policy('single');
    const db = database();
    const checker = preflight(db);
    const request = {
      ...input,
      resource: type === 'container' ? input.resource : { type, deploymentId: 'deployment' },
    };
    const before = await checker.run(request, [], false);
    expect(before.blockers).toEqual([]);
    find.mockResolvedValue({ mode: 'failover' } as never);
    const after = await checker.run(request, [], false);
    expect(after.blockers).toEqual([expect.objectContaining({ code: MIGRATION_AVAILABILITY_ENABLED })]);

    const service = new DockerMigrationService(
      db as never,
      {
        run: (value: DockerMigrationPreflightInput) => checker.run(value, [], false),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    await expect(
      service.create({ ...request, preflightFingerprint: before.fingerprint }, 'user', [])
    ).rejects.toMatchObject({ code: 'MIGRATION_PREFLIGHT_BLOCKED' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rechecks queued migrations under the lease before maintenance, cutover or executor dispatch', async () => {
    policy('replicated');
    const executor = { execute: vi.fn() };
    const coordinator = { enterMaintenance: vi.fn(), cutoverMetadata: vi.fn() };
    const service = new DockerMigrationService(
      database() as never,
      {} as never,
      executor as never,
      coordinator as never,
      {} as never,
      {} as never,
      {} as never
    ) as any;
    service.lease = { assertOwnership: vi.fn() };
    for (const phase of ['locking', 'maintenance', 'preparing', 'cutover', 'cleanup_source']) {
      await expect(service.executePhase({ ...row, phase })).rejects.toMatchObject({
        code: MIGRATION_AVAILABILITY_ENABLED,
      });
    }
    expect(executor.execute).not.toHaveBeenCalled();
    expect(coordinator.enterMaintenance).not.toHaveBeenCalled();
    expect(coordinator.cutoverMetadata).not.toHaveBeenCalled();
  });

  it('rechecks direct executor calls after HA is enabled and does not mutate or roll back placements', async () => {
    const find = policy('single');
    const dispatch = { finalize: vi.fn(), abort: vi.fn(), containerAction: vi.fn() };
    const executor = new DockerMigrationExecutor(
      database() as never,
      dispatch as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    await expect(executor.execute({ ...row, phase: 'finalizing' })).resolves.toEqual({});
    expect(dispatch.finalize).toHaveBeenCalledTimes(2);
    dispatch.finalize.mockClear();
    find.mockResolvedValue({ mode: 'replicated' } as never);
    for (const phase of [
      'preparing',
      'stopping_source',
      'creating_target',
      'starting_target',
      'cleanup_source',
      'finalizing',
    ] as const) {
      await expect(executor.execute({ ...row, phase })).rejects.toMatchObject({ code: MIGRATION_AVAILABILITY_ENABLED });
    }
    await expect(executor.rollback(row)).rejects.toMatchObject({ code: MIGRATION_AVAILABILITY_ENABLED });
    expect(dispatch.finalize).not.toHaveBeenCalled();
    expect(dispatch.abort).not.toHaveBeenCalled();
    expect(dispatch.containerAction).not.toHaveBeenCalled();
  });

  it('leaves HA races for operator attention instead of automatically restoring or deleting placements', async () => {
    const service = new DockerMigrationService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    ) as any;
    service.update = vi.fn().mockResolvedValue(row);
    service.lease = { release: vi.fn() };
    service.log = vi.fn();
    service.rollback = vi.fn();
    await service.handleFailure(row, new AppError(409, MIGRATION_AVAILABILITY_ENABLED, 'Disable Availability first'));
    expect(service.update).toHaveBeenCalledWith(
      row.id,
      expect.objectContaining({
        status: 'needs_attention',
        errorCode: MIGRATION_AVAILABILITY_ENABLED,
      })
    );
    expect(service.lease.release).toHaveBeenCalledWith(row.id);
    expect(service.rollback).not.toHaveBeenCalled();
  });
});
