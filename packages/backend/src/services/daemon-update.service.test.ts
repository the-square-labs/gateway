import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { DaemonUpdateService, daemonTypeForNodeType } from './daemon-update.service.js';

describe('DaemonUpdateService update artifact URLs', () => {
  it('passes the persisted Preview channel to daemon release resolution', async () => {
    const nodes = [{ id: 'node-1', type: 'nginx', daemonVersion: 'v2.9.15', hostname: 'edge' }];
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockResolvedValue(nodes) })),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn() })) })),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    };
    const service = new DaemonUpdateService(
      db as never,
      {
        RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
        ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
      } as Env,
      { getConfig: vi.fn().mockResolvedValue({ updateChannel: 'preview' }) } as never
    );
    vi.spyOn(service, 'getCachedStatus').mockResolvedValue([]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await service.checkForUpdates();
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        'https://updates.thesqlabs.com/gateway/releases?component=nginx-daemon&current=v2.9.15&channel=preview'
      );
      expect(db.delete).toHaveBeenCalledTimes(12);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('updates builder nodes with the existing docker-daemon artifact family', () => {
    expect(daemonTypeForNodeType('builder')).toBe('docker');
  });

  it('hides a cached daemon release candidate immediately after switching back to Stable', async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn().mockResolvedValue([{ id: 'node-1', type: 'nginx', daemonVersion: 'v2.9.15', hostname: 'edge' }]),
      })),
    } as never;
    const service = new DaemonUpdateService(
      db,
      {
        RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
        ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
      } as Env,
      { getConfig: vi.fn().mockResolvedValue({ updateChannel: 'stable' }) } as never
    );
    vi.spyOn(service as any, 'getSetting').mockImplementation(async (...args: unknown[]) => {
      const key = args[0];
      if (key === 'daemon-update:nginx:latest_version') return 'v2.10.0-rc.1';
      if (key === 'daemon-update:nginx:latest_tag') return 'v2.10.0-rc.1-nginx';
      return null;
    });

    const status = await service.getCachedStatus();
    expect(status.find((item) => item.daemonType === 'nginx')).toMatchObject({
      latestVersion: null,
      nodes: [expect.objectContaining({ updateAvailable: false })],
    });
    await expect(service.getLatestRelease('nginx')).resolves.toBeNull();
  });

  it('builds signed artifact URLs from the GitHub update facade', () => {
    const service = new DaemonUpdateService(
      {} as DrizzleClient,
      {
        ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
        RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      } as Env
    );

    expect(service.getDownloadUrl('nginx', 'v9.9.9-nginx', 'amd64')).toBe(
      'https://updates.thesqlabs.com/gateway/nginx-daemon/v9.9.9-nginx/nginx-daemon-linux-amd64'
    );
    expect(service.getManifestUrl('nginx', 'v9.9.9-nginx', 'amd64')).toBe(
      'https://updates.thesqlabs.com/gateway/nginx-daemon/v9.9.9-nginx/nginx-daemon-linux-amd64.update.json'
    );
  });

  it('publishes the relay worker inside the supervisor package with its own artifact scope', () => {
    const service = new DaemonUpdateService(
      {} as DrizzleClient,
      {
        ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
        RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      } as Env
    );

    expect(service.getDownloadUrl('relay-worker', 'v2.7.0-relay', 'aarch64')).toBe(
      'https://updates.thesqlabs.com/gateway/relay-supervisor/v2.7.0-relay/relay-worker-linux-arm64'
    );
    expect(service.getManifestUrl('relay-worker', 'v2.7.0-relay', 'arm64')).toBe(
      'https://updates.thesqlabs.com/gateway/relay-supervisor/v2.7.0-relay/relay-worker-linux-arm64.update.json'
    );
  });

  it('uses the provider-neutral Gateway artifact namespace', () => {
    const service = new DaemonUpdateService(
      {} as DrizzleClient,
      {
        ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway/',
        RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      } as Env
    );

    expect(service.getDownloadUrl('docker', 'v2.9.11-docker', 'amd64')).toBe(
      'https://updates.thesqlabs.com/gateway/docker-daemon/v2.9.11-docker/docker-daemon-linux-amd64'
    );
    expect(service.getManifestUrl('docker', 'v2.9.11-docker', 'amd64')).toBe(
      'https://updates.thesqlabs.com/gateway/docker-daemon/v2.9.11-docker/docker-daemon-linux-amd64.update.json'
    );
  });

  it('keeps the update lock until the daemon reconnects on the target version', async () => {
    const metadata = {
      updateInProgress: true,
      updateTargetVersion: 'v2.6.0',
      updateStartedAt: '2026-08-12T00:00:00.000Z',
      updateOperationId: 'operation-1',
      updatePhase: 'reconnecting',
      updateDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
      updateReconnectStartedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const returning = vi.fn().mockResolvedValue([{ id: 'node-1' }]);
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) });
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ metadata }]) }),
        }),
      }),
      update: vi.fn().mockReturnValue({ set }),
    } as unknown as DrizzleClient;
    const service = new DaemonUpdateService(db, {
      RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
    } as Env);

    await expect(service.clearNodeUpdateInProgressOnReconnect('node-1', '2.5.2')).resolves.toBe(false);
    expect(set).not.toHaveBeenCalled();

    await expect(service.clearNodeUpdateInProgressOnReconnect('node-1', '2.6.0')).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith({ metadata: {}, updatedAt: expect.any(Date) });
  });

  it('expires an accepted update that never reconnects and marks a disconnected node offline', async () => {
    const metadata = {
      updateInProgress: true,
      updateTargetVersion: 'v2.10.0',
      updateStartedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
      updateOperationId: 'operation-1',
      updatePhase: 'reconnecting',
      updateDeadlineAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const returning = vi.fn().mockResolvedValue([{ id: 'node-1' }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ metadata }]) }),
        }),
      }),
      update: vi.fn().mockReturnValue({ set }),
    } as unknown as DrizzleClient;
    const setNodeUpdateInProgress = vi.fn();
    const service = new DaemonUpdateService(db, {
      RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
    } as Env);
    service.setNodeRegistry({ getNode: vi.fn().mockReturnValue(undefined), setNodeUpdateInProgress } as never);

    await expect(service.isNodeUpdateInProgress('node-1')).resolves.toBe(false);
    expect(set).toHaveBeenCalledWith({ metadata: {}, updatedAt: expect.any(Date), status: 'offline' });
    expect(setNodeUpdateInProgress).toHaveBeenCalledWith('node-1', false);
  });

  it('does not clear an update when a newer operation wins the expiry race', async () => {
    const metadata = {
      updateInProgress: true,
      updateTargetVersion: 'v2.10.0',
      updateStartedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
      updateOperationId: 'operation-1',
      updatePhase: 'reconnecting',
      updateDeadlineAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ metadata }]) }),
        }),
      }),
      update: vi.fn().mockReturnValue({ set }),
    } as unknown as DrizzleClient;
    const setNodeUpdateInProgress = vi.fn();
    const service = new DaemonUpdateService(db, {
      RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
    } as Env);
    service.setNodeRegistry({ getNode: vi.fn().mockReturnValue(undefined), setNodeUpdateInProgress } as never);

    await expect(service.isNodeUpdateInProgress('node-1')).resolves.toBe(true);
    expect(setNodeUpdateInProgress).not.toHaveBeenCalled();
  });

  it('keeps the six-minute execution lock through the command window then starts a fresh reconnect deadline', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-09-01T12:00:00.000Z');
    vi.setSystemTime(startedAt);
    let metadata: Record<string, unknown> = {};
    const set = vi.fn((values: { metadata: Record<string, unknown> }) => ({
      where: () => {
        metadata = values.metadata;
        return { returning: vi.fn().mockResolvedValue([{ id: 'node-1' }]) };
      },
    }));
    const db = {
      select: vi.fn().mockImplementation(() => ({
        from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([{ metadata }]) }) }),
      })),
      update: vi.fn().mockReturnValue({ set }),
    } as unknown as DrizzleClient;
    const service = new DaemonUpdateService(db, {
      RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
    } as Env);

    try {
      const operationId = await service.markNodeUpdateInProgress('node-1', 'v2.10.0');
      expect(metadata).toMatchObject({
        updateOperationId: operationId,
        updatePhase: 'executing',
        updateDeadlineAt: new Date(startedAt.getTime() + 6 * 60 * 1000).toISOString(),
      });

      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      await expect(service.isNodeUpdateInProgress('node-1')).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 31_000);
      await expect(service.isNodeUpdateInProgress('node-1')).resolves.toBe(true);

      service.trackNodeUpdateCompletion(
        'node-1',
        operationId,
        Promise.resolve({ commandId: 'cmd-1', success: true, error: '', detail: '', data: Buffer.alloc(0) })
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(metadata).toMatchObject({
        updateOperationId: operationId,
        updatePhase: 'reconnecting',
        updateReconnectStartedAt: new Date().toISOString(),
        updateDeadlineAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('reaps an expired persisted lock before acquiring a retry after backend restart', async () => {
    const expiredMetadata = {
      updateInProgress: true,
      updateTargetVersion: 'v2.10.0',
      updateStartedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      updateOperationId: 'operation-1',
      updatePhase: 'executing',
      updateDeadlineAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const selectRows = [[{ metadata: expiredMetadata }], [{ metadata: expiredMetadata }], [{ metadata: {} }]];
    const select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({ limit: vi.fn().mockResolvedValue(selectRows.shift() ?? []) }),
      }),
    }));
    const expireReturning = vi.fn().mockResolvedValue([{ id: 'node-1' }]);
    const acquireReturning = vi.fn().mockResolvedValue([{ id: 'node-1' }]);
    const update = vi
      .fn()
      .mockReturnValueOnce({ set: () => ({ where: () => ({ returning: expireReturning }) }) })
      .mockReturnValueOnce({ set: () => ({ where: () => ({ returning: acquireReturning }) }) });
    const service = new DaemonUpdateService(
      { select, update } as unknown as DrizzleClient,
      {
        RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
        ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
      } as Env
    );
    service.setNodeRegistry({ getNode: vi.fn().mockReturnValue(undefined), setNodeUpdateInProgress: vi.fn() } as never);

    await expect(service.markNodeUpdateInProgress('node-1', 'v2.10.1')).resolves.toEqual(expect.any(String));
    expect(expireReturning).toHaveBeenCalledOnce();
    expect(acquireReturning).toHaveBeenCalledOnce();
  });

  it('does not let an old completion clear a newer update operation', async () => {
    const metadata = {
      updateInProgress: true,
      updateTargetVersion: 'v2.10.1',
      updateOperationId: 'operation-2',
      updatePhase: 'executing',
      updateDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const update = vi.fn();
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ metadata }]) }),
        }),
      }),
      update,
    } as unknown as DrizzleClient;
    const service = new DaemonUpdateService(db, {
      RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
    } as Env);

    await expect(service.clearNodeUpdateInProgress('node-1', 'operation-1')).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('does not let an older registration clear a newer reconnecting operation', async () => {
    const reconnectStartedAt = new Date();
    const metadata = {
      updateInProgress: true,
      updateTargetVersion: 'v2.10.0',
      updateOperationId: 'operation-2',
      updatePhase: 'reconnecting',
      updateDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
      updateReconnectStartedAt: reconnectStartedAt.toISOString(),
    };
    const update = vi.fn();
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ metadata }]) }),
        }),
      }),
      update,
    } as unknown as DrizzleClient;
    const setNodeUpdateInProgress = vi.fn();
    const service = new DaemonUpdateService(db, {
      RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
    } as Env);
    service.setNodeRegistry({ setNodeUpdateInProgress } as never);

    await expect(
      service.clearNodeUpdateInProgressOnReconnect('node-1', 'v2.10.0', new Date(reconnectStartedAt.getTime() - 1))
    ).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(setNodeUpdateInProgress).not.toHaveBeenCalled();
  });

  it('starts the reconnect deadline when the command times out', async () => {
    const service = new DaemonUpdateService(
      {} as DrizzleClient,
      {
        RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
        ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
      } as Env
    );
    const beginReconnect = vi.spyOn(service as any, 'beginNodeUpdateReconnectDeadline').mockResolvedValue(true);

    service.trackNodeUpdateCompletion(
      'node-1',
      'operation-1',
      Promise.reject(new Error('Command cmd-1 timed out after 330000ms'))
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(beginReconnect).toHaveBeenCalledWith('node-1', 'operation-1');
  });

  it('keeps the update lock when the daemon disconnects for its expected restart', async () => {
    const service = new DaemonUpdateService(
      {} as DrizzleClient,
      {
        RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
        ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
      } as Env
    );
    const clear = vi.spyOn(service, 'clearNodeUpdateInProgress').mockResolvedValue(false);
    const beginReconnect = vi.spyOn(service as any, 'beginNodeUpdateReconnectDeadline').mockResolvedValue(true);

    service.trackNodeUpdateCompletion('node-1', 'operation-1', Promise.reject(new Error('Node disconnected')));
    await Promise.resolve();
    await Promise.resolve();

    expect(clear).not.toHaveBeenCalled();
    expect(beginReconnect).toHaveBeenCalledWith('node-1', 'operation-1');
  });

  it('clears the update lock after an explicit daemon rejection', async () => {
    const service = new DaemonUpdateService(
      {} as DrizzleClient,
      {
        RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
        ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
      } as Env
    );
    const clear = vi.spyOn(service, 'clearNodeUpdateInProgress').mockResolvedValue(true);

    service.trackNodeUpdateCompletion(
      'node-1',
      'operation-1',
      Promise.resolve({
        commandId: 'cmd-1',
        success: false,
        error: 'checksum mismatch',
        detail: '',
        data: Buffer.alloc(0),
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(clear).toHaveBeenCalledWith('node-1', 'operation-1');
  });
});
