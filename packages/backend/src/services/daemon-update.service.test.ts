import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { DaemonUpdateService } from './daemon-update.service.js';

describe('DaemonUpdateService update artifact URLs', () => {
  it('normalizes a trailing GitLab API slash before building signed artifact URLs', () => {
    const service = new DaemonUpdateService(
      {} as DrizzleClient,
      {
        GITLAB_API_URL: 'https://gitlab.wiolett.net/',
        GITLAB_PROJECT_PATH: 'wiolett/gateway',
      } as Env
    );

    expect(service.getDownloadUrl('nginx', 'v9.9.9-nginx', 'amd64')).toBe(
      'https://gitlab.wiolett.net/api/v4/projects/wiolett%2Fgateway/packages/generic/nginx-daemon/v9.9.9-nginx/nginx-daemon-linux-amd64'
    );
    expect(service.getManifestUrl('nginx', 'v9.9.9-nginx', 'amd64')).toBe(
      'https://gitlab.wiolett.net/api/v4/projects/wiolett%2Fgateway/packages/generic/nginx-daemon/v9.9.9-nginx/nginx-daemon-linux-amd64.update.json'
    );
  });

  it('publishes the relay worker inside the supervisor package with its own artifact scope', () => {
    const service = new DaemonUpdateService(
      {} as DrizzleClient,
      {
        GITLAB_API_URL: 'https://gitlab.wiolett.net',
        GITLAB_PROJECT_PATH: 'wiolett/gateway',
      } as Env
    );

    expect(service.getDownloadUrl('relay-worker', 'v2.7.0-relay', 'aarch64')).toBe(
      'https://gitlab.wiolett.net/api/v4/projects/wiolett%2Fgateway/packages/generic/relay-supervisor/v2.7.0-relay/relay-worker-linux-arm64'
    );
    expect(service.getManifestUrl('relay-worker', 'v2.7.0-relay', 'arm64')).toBe(
      'https://gitlab.wiolett.net/api/v4/projects/wiolett%2Fgateway/packages/generic/relay-supervisor/v2.7.0-relay/relay-worker-linux-arm64.update.json'
    );
  });

  it('keeps the update lock until the daemon reconnects on the target version', async () => {
    const metadata = {
      updateInProgress: true,
      updateTargetVersion: 'v2.6.0',
      updateStartedAt: '2026-08-12T00:00:00.000Z',
    };
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ metadata }]) }),
        }),
      }),
      update: vi.fn().mockReturnValue({ set }),
    } as unknown as DrizzleClient;
    const service = new DaemonUpdateService(db, {
      GITLAB_API_URL: 'https://gitlab.wiolett.net',
      GITLAB_PROJECT_PATH: 'wiolett/gateway',
    } as Env);

    await expect(service.clearNodeUpdateInProgressOnReconnect('node-1', '2.5.2')).resolves.toBe(false);
    expect(set).not.toHaveBeenCalled();

    await expect(service.clearNodeUpdateInProgressOnReconnect('node-1', '2.6.0')).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith({ metadata: {}, updatedAt: expect.any(Date) });
  });

  it('keeps the update lock when the daemon disconnects for its expected restart', async () => {
    const service = new DaemonUpdateService(
      {} as DrizzleClient,
      {
        GITLAB_API_URL: 'https://gitlab.wiolett.net',
        GITLAB_PROJECT_PATH: 'wiolett/gateway',
      } as Env
    );
    const clear = vi.spyOn(service, 'clearNodeUpdateInProgress').mockResolvedValue(undefined);

    service.trackNodeUpdateCompletion('node-1', Promise.reject(new Error('Node disconnected')));
    await Promise.resolve();
    await Promise.resolve();

    expect(clear).not.toHaveBeenCalled();
  });

  it('clears the update lock after an explicit daemon rejection', async () => {
    const service = new DaemonUpdateService(
      {} as DrizzleClient,
      {
        GITLAB_API_URL: 'https://gitlab.wiolett.net',
        GITLAB_PROJECT_PATH: 'wiolett/gateway',
      } as Env
    );
    const clear = vi.spyOn(service, 'clearNodeUpdateInProgress').mockResolvedValue(undefined);

    service.trackNodeUpdateCompletion(
      'node-1',
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

    expect(clear).toHaveBeenCalledWith('node-1');
  });
});
