import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { BackupService } from './backups.service.js';

describe('backup cleanup acknowledgement', () => {
  it('keeps the controller run active until the daemon reclaims its workspace', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
    const service = new BackupService(
      { update: vi.fn(() => ({ set })) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const internals = service as unknown as {
      getRun: () => Promise<unknown>;
      applyRunnerDetail: (id: string, detail: unknown) => Promise<void>;
      finish: (...args: unknown[]) => Promise<void>;
    };
    internals.getRun = vi.fn(async () => ({ id: 'run', status: 'running', direction: 'restore' }));
    internals.finish = vi.fn(async () => undefined);
    await internals.applyRunnerDetail('run', { status: 'completed', cleanupPending: true });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'running', phase: 'cleanup_pending' }));
    expect(internals.finish).not.toHaveBeenCalled();
    await internals.applyRunnerDetail('run', { status: 'completed', cleanupPending: false });
    expect(internals.finish).toHaveBeenCalledWith('run', 'completed', 'completed', undefined, undefined, undefined);
  });
});

describe('backup replay authorization', () => {
  it('cancels revoked work without resending credentials to preflight or start', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
    const dispatch = {
      sendDockerBackupCommand: vi.fn().mockResolvedValue({ success: false, error: 'BACKUP_RUN_UNKNOWN' }),
    };
    const auth = {
      assertSource: vi.fn().mockRejectedValue(new AppError(403, 'FORBIDDEN', 'revoked')),
      assertDestination: vi.fn(),
      assertExecutor: vi.fn(),
    };
    const service = new BackupService(
      { update: vi.fn(() => ({ set })) } as never,
      {} as never,
      {} as never,
      dispatch,
      {} as never,
      auth as never,
      {} as never,
      {} as never,
      {} as never
    );
    const inner = service as unknown as {
      resumeDispatch: (run: unknown, payload: unknown, preflight: boolean) => Promise<void>;
      finish: (...args: unknown[]) => Promise<void>;
    };
    inner.finish = vi.fn(async () => undefined);
    await inner.resumeDispatch(
      {
        id: 'run',
        createdById: 'actor',
        databaseConnectionId: 'source',
        destinationId: 'store',
        executorNodeId: 'node',
        direction: 'backup',
      },
      {},
      true
    );
    expect(dispatch.sendDockerBackupCommand).toHaveBeenCalledExactlyOnceWith('node', 'cancel', 'run', '', 15000);
    expect(inner.finish).toHaveBeenCalledWith('run', 'cancelled', 'authorization_revoked');
  });
  it('checks destination read and target edit rights before replaying restore', async () => {
    const auth = {
      assertSource: vi.fn(),
      assertDestination: vi.fn(),
      assertExecutor: vi.fn(),
      assertRestoreTarget: vi.fn(),
    };
    const service = new BackupService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      auth as never,
      {} as never,
      {} as never,
      {} as never
    );
    const inner = service as unknown as { authorizeDispatch: (run: unknown, payload: unknown) => Promise<boolean> };
    await expect(
      inner.authorizeDispatch(
        {
          id: 'run',
          createdById: 'actor',
          databaseConnectionId: 'source',
          destinationId: 'store',
          executorNodeId: 'node',
          direction: 'restore',
        },
        { restoreTarget: { connectionId: 'target' } }
      )
    ).resolves.toBe(true);
    expect(auth.assertSource).toHaveBeenCalledWith('actor', 'source', 'restore');
    expect(auth.assertDestination).toHaveBeenCalledWith('actor', 'store', 'read');
    expect(auth.assertRestoreTarget).toHaveBeenCalledWith('actor', 'target');
  });
});
