import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { waitForShutdownTasks } from '@/services/shutdown-coordinator.service.js';
import { DockerMigrationService } from './docker-migration.service.js';

vi.mock('./docker-migration-availability.js', () => ({
  assertMigrationAvailabilityAllowed: vi.fn().mockResolvedValue(undefined),
  MIGRATION_AVAILABILITY_ENABLED: 'MIGRATION_AVAILABILITY_ENABLED',
}));

function createService() {
  return new DockerMigrationService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
}

describe('DockerMigrationService graceful shutdown', () => {
  const containerScopes = ['migrate', 'view', 'manage', 'environment', 'secrets', 'create', 'delete'].map(
    (action) => `docker:containers:${action}`
  );
  const permissionRow = {
    id: 'migration-1',
    phase: 'preparing',
    resourceType: 'container',
    resourceName: 'app',
    sourceNodeId: 'source',
    targetNodeId: 'target',
    createdById: 'creator',
    keepSource: true,
    cutoverAt: null,
    plan: {},
    preflight: {
      scopeResourceId: 'resource',
      targetFolderId: null,
      artifacts: [],
      proxyHosts: [],
      dependencyPermissions: { volumes: [], networks: [], proxyHostIds: [] },
    },
  };

  it.each([
    null,
    { scopes: ['*'], isBlocked: true },
    { scopes: [], isBlocked: false },
  ])('denies a queued/resumed phase before dispatch when the actor lost access (%j)', async (actor) => {
    const runtime = createService() as any;
    runtime.auth = { getUserById: vi.fn().mockResolvedValue(actor) };
    runtime.lease = { assertOwnership: vi.fn().mockResolvedValue(undefined) };
    runtime.executor = { execute: vi.fn() };
    await expect(runtime.executePhase(permissionRow)).rejects.toMatchObject({ code: 'MIGRATION_PERMISSION_DENIED' });
    expect(runtime.executor.execute).not.toHaveBeenCalled();
  });

  it('loads fresh scopes at each phase instead of retaining the original grants', async () => {
    const runtime = createService() as any;
    runtime.auth = {
      getUserById: vi
        .fn()
        .mockResolvedValueOnce({ scopes: containerScopes, isBlocked: false })
        .mockResolvedValueOnce({ scopes: [], isBlocked: false }),
    };
    await expect(runtime.authorizePhase(permissionRow)).resolves.toBeUndefined();
    await expect(runtime.authorizePhase(permissionRow)).rejects.toMatchObject({ code: 'MIGRATION_PERMISSION_DENIED' });
    expect(runtime.auth.getUserById).toHaveBeenCalledTimes(2);
  });

  it('does not delete target resources through rollback when initial authorization is denied', async () => {
    const runtime = createService() as any;
    runtime.update = vi.fn().mockResolvedValue(permissionRow);
    runtime.lease = { release: vi.fn() };
    runtime.clearMigrating = vi.fn();
    runtime.log = vi.fn();
    runtime.rollback = vi.fn();
    await runtime.handleFailure(
      { ...permissionRow, phase: 'locking' },
      new AppError(403, 'MIGRATION_PERMISSION_DENIED', 'Access revoked')
    );
    expect(runtime.update).toHaveBeenCalledWith(permissionRow.id, expect.objectContaining({ status: 'failed' }));
    expect(runtime.rollback).not.toHaveBeenCalled();
    expect(runtime.lease.release).toHaveBeenCalledWith(permissionRow.id);
  });

  it('reauthorizes a cleanup retry as the user who requested the retry', async () => {
    const runtime = createService() as any;
    runtime.auth = { getUserById: vi.fn().mockResolvedValue({ scopes: containerScopes, isBlocked: false }) };
    await runtime.authorizePhase({
      ...permissionRow,
      phase: 'cleanup_source',
      cutoverAt: new Date(),
      keepSource: false,
      plan: { cleanupActorId: 'cleanup-operator' },
    });
    expect(runtime.auth.getUserById).toHaveBeenCalledWith('cleanup-operator');
  });

  it('passes current actor scopes to the locking preflight', async () => {
    const runtime = createService() as any;
    runtime.auth = { getUserById: vi.fn().mockResolvedValue({ scopes: ['current-grant'], isBlocked: false }) };
    runtime.preflight = { run: vi.fn().mockResolvedValue({ fingerprint: 'same', blockers: [] }) };
    await runtime.recheckPreflight({ ...permissionRow, sourceFingerprint: 'same' });
    expect(runtime.preflight.run).toHaveBeenCalledWith(expect.any(Object), ['current-grant']);
  });

  it('places copied volumes in their authorized folder before publishing target inventory', async () => {
    const runtime = createService() as any;
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) });
    runtime.db = { insert: vi.fn().mockReturnValue({ values }) };
    await runtime.placeDependencies({
      ...permissionRow,
      phase: 'transferring',
      preflight: {
        ...permissionRow.preflight,
        dependencyPermissions: {
          volumes: [{ resourceId: 'data', folderId: 'folder-1' }],
          networks: [],
          proxyHostIds: [],
        },
      },
    });
    expect(values).toHaveBeenCalledWith({
      nodeId: 'target',
      resourceType: 'volume',
      resourceKey: 'data',
      folderId: 'folder-1',
    });
  });

  it('finishes the active phase, releases the lease, and does not start the next phase', async () => {
    const service = createService();
    const runtime = service as any;
    const row = {
      id: 'migration-1',
      status: 'running',
      phase: 'preparing',
      createdById: 'user-1',
      cancellationRequestedAt: null,
      cutoverAt: null,
    };
    let phaseStarted!: () => void;
    let finishPhase!: () => void;
    const started = new Promise<void>((resolve) => (phaseStarted = resolve));
    const phase = new Promise<void>((resolve) => (finishPhase = resolve));
    runtime.lease = {
      claim: vi.fn().mockResolvedValue(true),
      acquireNodeLocks: vi.fn().mockResolvedValue(undefined),
      heartbeat: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    };
    runtime.getRow = vi.fn().mockResolvedValue(row);
    runtime.update = vi.fn().mockResolvedValue(row);
    runtime.log = vi.fn().mockResolvedValue(undefined);
    runtime.handleFailure = vi.fn().mockResolvedValue(undefined);
    runtime.executePhase = vi.fn(async () => {
      phaseStarted();
      await phase;
    });

    runtime.queue(row.id);
    await started;
    const stopping = service.stop();
    const stopGrpc = vi.fn();
    const dependentTeardown = (async () => {
      if (!(await waitForShutdownTasks([stopping], Date.now() + 1_000))) {
        throw new Error('Migration did not reach its phase boundary');
      }
      stopGrpc();
    })();
    expect(stopGrpc).not.toHaveBeenCalled();
    finishPhase();
    await Promise.all([stopping, dependentTeardown]);

    expect(runtime.executePhase).toHaveBeenCalledOnce();
    expect(runtime.lease.release).toHaveBeenCalledWith(row.id);
    expect(runtime.handleFailure).not.toHaveBeenCalled();
    expect(runtime.lease.release.mock.invocationCallOrder[0]).toBeLessThan(stopGrpc.mock.invocationCallOrder[0]);
  });

  it('does not enqueue new work after quiescing and schedules recovery after a fresh start', async () => {
    const service = createService();
    const runtime = service as any;
    runtime.getRow = vi.fn();

    await service.stop();
    runtime.queue('migration-1');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.getRow).not.toHaveBeenCalled();

    runtime.recoverOnStartup = vi.fn().mockResolvedValue(0);
    service.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.recoverOnStartup).toHaveBeenCalledOnce();
    await service.stop();
  });
});
