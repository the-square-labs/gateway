import { describe, expect, it, vi } from 'vitest';
import { AISandboxService } from './ai.sandbox.service.js';

describe('AISandboxService', () => {
  it('waits for active policy reconciliation and cannot schedule more work after stopping', async () => {
    let resolveRows!: (rows: never[]) => void;
    const rows = new Promise<never[]>((resolve) => {
      resolveRows = resolve;
    });
    const jobs = {
      listActiveWithEffectiveScopes: vi.fn().mockReturnValue(rows),
    };
    const service = new AISandboxService(jobs as never, {} as never, {} as never);

    service.startPolicyReconciliation();
    expect(jobs.listActiveWithEffectiveScopes).toHaveBeenCalledOnce();

    let stopped = false;
    const stopping = service.stopPolicyReconciliation().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveRows([]);
    await stopping;
    service.startPolicyReconciliation();
    expect(jobs.listActiveWithEffectiveScopes).toHaveBeenCalledOnce();
  });

  it('kills and expires active jobs whose TTL has passed during reconciliation', async () => {
    const expiredJob = {
      id: 'job-1',
      containerId: 'container-1',
      expiresAt: new Date(Date.now() - 1_000),
      requiredScopes: [],
    };
    const jobs = {
      listActiveWithEffectiveScopes: vi.fn().mockResolvedValue([
        {
          job: expiredJob,
          userId: 'user-1',
          currentScopes: [],
        },
      ]),
      markFinished: vi.fn().mockResolvedValue({}),
    };
    const runner = {
      killProcess: vi.fn().mockResolvedValue({ processId: 'container-1', killed: true }),
    };
    const service = new AISandboxService(jobs as never, runner as never, {} as never);

    await expect(service.reconcileActiveJobs()).resolves.toEqual({ checked: 1, expired: 1, revoked: 0 });
    expect(runner.killProcess).toHaveBeenCalledWith({ processId: 'container-1' });
    expect(jobs.markFinished).toHaveBeenCalledWith('job-1', 'expired');
  });

  it('marks run_process jobs exited when their container finishes before TTL', async () => {
    const user = { id: 'user-1', scopes: ['ai:sandbox:use'] };
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const jobs = {
      create: vi.fn().mockResolvedValue({ id: 'job-1' }),
      markRunning: vi.fn().mockResolvedValue({}),
      markFinished: vi.fn().mockResolvedValue({}),
      markFinishedIfActive: vi.fn().mockResolvedValue({ id: 'job-1', status: 'exited' }),
    };
    const runner = {
      runProcess: vi.fn().mockResolvedValue({
        processId: 'container-1',
        containerId: 'container-1',
        expiresAt,
      }),
      waitProcess: vi.fn().mockResolvedValue({ processId: 'container-1', exitCode: 2, outputBytes: 56 }),
      killProcess: vi.fn().mockResolvedValue({ processId: 'container-1', killed: true }),
    };
    const service = new AISandboxService(jobs as never, runner as never, {} as never);

    await expect(
      service.runProcess(user as never, {
        command: ['sh', '-lc', 'exit 2'],
        conversationId: 'conversation-1',
      })
    ).resolves.toMatchObject({
      jobId: 'job-1',
      processId: 'container-1',
      containerId: 'container-1',
    });

    expect(jobs.markRunning).toHaveBeenCalledWith('job-1', 'container-1');
    expect(runner.waitProcess).toHaveBeenCalledWith({ processId: 'container-1', timeoutMs: expect.any(Number) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(jobs.markFinishedIfActive).toHaveBeenCalledWith('job-1', 'exited', {
      exitCode: 2,
      outputBytes: 56,
      workspaceUsageBytes: undefined,
    });
    expect(runner.killProcess).toHaveBeenCalledWith({ processId: 'container-1' });
  });

  it('reattaches terminal monitoring to an active container after backend restart', async () => {
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
    const job = {
      id: 'job-recovered',
      kind: 'process',
      containerId: 'container-recovered',
      expiresAt,
      requiredScopes: ['ai:sandbox:use'],
      workspaceReservationBytes: 2 * 1024 * 1024 * 1024,
    };
    const jobs = {
      listActiveWithEffectiveScopes: vi
        .fn()
        .mockResolvedValue([{ job, userId: 'user-1', currentScopes: ['ai:sandbox:use'] }]),
      update: vi.fn().mockResolvedValue({}),
      markFinishedIfActive: vi.fn().mockResolvedValue({ id: job.id, status: 'exited' }),
    };
    const runner = {
      findJobContainer: vi
        .fn()
        .mockResolvedValue({ containerId: job.containerId, expiresAt: job.expiresAt.toISOString() }),
      getWorkspaceUsage: vi
        .fn()
        .mockResolvedValue({ workspaceUsageBytes: 512, workspaceReservationBytes: 1024, overReservation: false }),
      waitProcess: vi.fn().mockResolvedValue({ exitCode: 0, outputBytes: 12, workspaceUsageBytes: 512 }),
      killProcess: vi.fn().mockResolvedValue({ processId: job.containerId, killed: true }),
    };
    const service = new AISandboxService(jobs as never, runner as never, {} as never);

    await service.reconcileActiveJobs();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runner.findJobContainer).toHaveBeenCalledWith({ jobId: job.id });
    const recoveredWait = runner.waitProcess.mock.calls[0]?.[0];
    expect(recoveredWait?.processId).toBe(job.containerId);
    expect(recoveredWait?.timeoutMs).toBeGreaterThan(11 * 60 * 60 * 1000);
    expect(recoveredWait?.timeoutMs).toBeLessThanOrEqual(12 * 60 * 60 * 1000 + 10_000);
    expect(runner.killProcess).toHaveBeenCalledWith({ processId: job.containerId });
    expect(jobs.markFinishedIfActive).toHaveBeenCalledWith(job.id, 'exited', {
      exitCode: 0,
      outputBytes: 12,
      workspaceUsageBytes: 512,
    });
  });

  it('stops a sandbox that exceeds its observed workspace reservation', async () => {
    const job = {
      id: 'job-over-quota',
      containerId: 'container-over-quota',
      expiresAt: new Date(Date.now() + 60_000),
      requiredScopes: [],
      workspaceReservationBytes: 1024,
    };
    const jobs = {
      listActiveWithEffectiveScopes: vi.fn().mockResolvedValue([{ job, userId: 'user-1', currentScopes: [] }]),
      markFinishedIfActive: vi.fn().mockResolvedValue({ id: job.id, status: 'failed' }),
    };
    const runner = {
      findJobContainer: vi
        .fn()
        .mockResolvedValue({ containerId: job.containerId, expiresAt: job.expiresAt.toISOString() }),
      getWorkspaceUsage: vi
        .fn()
        .mockResolvedValue({ workspaceUsageBytes: 2048, workspaceReservationBytes: 1024, overReservation: true }),
      killProcess: vi.fn().mockResolvedValue({ processId: job.containerId, killed: true }),
    };
    const service = new AISandboxService(jobs as never, runner as never, {} as never);

    await expect(service.reconcileActiveJobs()).resolves.toEqual({ checked: 1, expired: 0, revoked: 0 });
    expect(runner.killProcess).toHaveBeenCalledWith({ processId: job.containerId });
    expect(jobs.markFinishedIfActive).toHaveBeenCalledWith(job.id, 'failed', {
      error: 'Sandbox workspace exceeded its reserved capacity',
      workspaceUsageBytes: 2048,
    });
  });

  it('fails an active job when its recorded container has vanished', async () => {
    const job = {
      id: 'job-missing-container',
      containerId: 'container-missing',
      expiresAt: new Date(Date.now() + 60_000),
      requiredScopes: [],
    };
    const jobs = {
      listActiveWithEffectiveScopes: vi.fn().mockResolvedValue([{ job, userId: 'user-1', currentScopes: [] }]),
      markFinishedIfActive: vi.fn().mockResolvedValue({ id: job.id, status: 'failed' }),
    };
    const runner = {
      findJobContainer: vi.fn().mockResolvedValue({ containerId: null, expiresAt: null }),
    };
    const service = new AISandboxService(jobs as never, runner as never, {} as never);

    await expect(service.reconcileActiveJobs()).resolves.toEqual({ checked: 1, expired: 0, revoked: 0 });
    expect(jobs.markFinishedIfActive).toHaveBeenCalledWith(job.id, 'failed', {
      error: 'Sandbox container is no longer available',
    });
  });

  it('keeps a newly-created unbound job within the creation grace period', async () => {
    const job = {
      id: 'job-creating',
      containerId: null,
      createdAt: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 60_000),
      requiredScopes: [],
    };
    const jobs = {
      listActiveWithEffectiveScopes: vi.fn().mockResolvedValue([{ job, userId: 'user-1', currentScopes: [] }]),
      markFinishedIfActive: vi.fn(),
    };
    const runner = {
      findJobContainer: vi.fn().mockResolvedValue({ containerId: null, expiresAt: null }),
    };
    const service = new AISandboxService(jobs as never, runner as never, {} as never);

    await expect(service.reconcileActiveJobs()).resolves.toEqual({ checked: 1, expired: 0, revoked: 0 });
    expect(jobs.markFinishedIfActive).not.toHaveBeenCalled();
  });

  it('returns a capacity error instead of an internal error when runner admission rejects a sandbox', async () => {
    const user = { id: 'user-1', scopes: ['ai:sandbox:use'] };
    const jobs = {
      create: vi.fn().mockResolvedValue({ id: 'job-1' }),
      markFinished: vi.fn().mockResolvedValue({}),
    };
    const runner = {
      runProcess: vi
        .fn()
        .mockRejectedValue(
          new Error('sandbox workspace admission denied: projected 800 bytes reaches the 80% host-disk limit')
        ),
    };
    const service = new AISandboxService(jobs as never, runner as never, {} as never);

    await expect(service.runProcess(user as never, { command: ['true'] })).rejects.toMatchObject({
      statusCode: 507,
      code: 'SANDBOX_DISK_ADMISSION_DENIED',
    });
    expect(jobs.markFinished).toHaveBeenCalledWith('job-1', 'failed', {
      error: 'sandbox workspace admission denied: projected 800 bytes reaches the 80% host-disk limit',
    });
  });

  it('uploads backend-managed artifacts into an owned sandbox workspace', async () => {
    const user = { id: 'user-1', scopes: ['ai:sandbox:use'] };
    const jobs = {
      get: vi.fn().mockRejectedValue(new Error('not found')),
      findByContainerId: vi.fn().mockResolvedValue({ id: 'job-1', userId: 'user-1', containerId: 'container-1' }),
    };
    const runner = {
      uploadArtifact: vi
        .fn()
        .mockResolvedValue({ processId: 'container-1', path: 'repo/archive.tar.gz', sizeBytes: 12 }),
    };
    const service = new AISandboxService(jobs as never, runner as never, {} as never);

    await expect(
      service.uploadArtifact(user as never, {
        processId: 'container-1',
        path: 'repo/archive.tar.gz',
        contentBase64: Buffer.from('archive-body').toString('base64'),
      })
    ).resolves.toEqual({ processId: 'container-1', path: 'repo/archive.tar.gz', sizeBytes: 12 });

    expect(runner.uploadArtifact).toHaveBeenCalledWith({
      processId: 'container-1',
      path: 'repo/archive.tar.gz',
      contentBase64: Buffer.from('archive-body').toString('base64'),
    });
  });

  it('streams a backend-managed archive into an owned sandbox in bounded chunks', async () => {
    const user = { id: 'user-1', scopes: ['ai:sandbox:use'] };
    const jobs = {
      get: vi.fn().mockRejectedValue(new Error('not found')),
      findByContainerId: vi.fn().mockResolvedValue({ id: 'job-1', userId: 'user-1', containerId: 'container-1' }),
    };
    let storedBytes = 0;
    const runner = {
      uploadArtifactChunk: vi.fn(async (input: { contentBase64: string }) => {
        storedBytes += Buffer.from(input.contentBase64, 'base64').byteLength;
        return { processId: 'container-1', path: '.gateway/archive.tar.gz', sizeBytes: storedBytes };
      }),
    };
    const service = new AISandboxService(jobs as never, runner as never, {} as never);

    async function* archiveChunks() {
      yield Buffer.alloc(300 * 1024, 1);
      yield Buffer.alloc(12 * 1024, 2);
    }

    await expect(
      service.uploadArtifactStream(user as never, {
        processId: 'container-1',
        path: '.gateway/archive.tar.gz',
        chunks: archiveChunks(),
        maxBytes: 512 * 1024,
      })
    ).resolves.toEqual({ processId: 'container-1', path: '.gateway/archive.tar.gz', sizeBytes: 312 * 1024 });

    expect(runner.uploadArtifactChunk).toHaveBeenCalledTimes(3);
    for (const call of runner.uploadArtifactChunk.mock.calls) {
      expect(Buffer.from(call[0].contentBase64, 'base64').byteLength).toBeLessThanOrEqual(256 * 1024);
    }
  });

  it('rejects an empty backend-managed archive instead of leaving a sandbox waiting forever', async () => {
    const user = { id: 'user-1', scopes: ['ai:sandbox:use'] };
    const jobs = {
      get: vi.fn().mockRejectedValue(new Error('not found')),
      findByContainerId: vi.fn().mockResolvedValue({ id: 'job-1', userId: 'user-1', containerId: 'container-1' }),
    };
    const service = new AISandboxService(jobs as never, { uploadArtifactChunk: vi.fn() } as never, {} as never);

    async function* emptyArchive() {
      // The provider yielded no bytes.
    }

    await expect(
      service.uploadArtifactStream(user as never, {
        processId: 'container-1',
        path: '.gateway/archive.tar.gz',
        chunks: emptyArchive(),
        maxBytes: 512 * 1024,
      })
    ).rejects.toMatchObject({ code: 'GITLAB_ARCHIVE_EMPTY' });
  });
});
