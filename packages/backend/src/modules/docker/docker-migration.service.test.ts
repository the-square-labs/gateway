import { describe, expect, it, vi } from 'vitest';
import { waitForShutdownTasks } from '@/services/shutdown-coordinator.service.js';
import { DockerMigrationService } from './docker-migration.service.js';

function createService() {
  return new DockerMigrationService(
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
