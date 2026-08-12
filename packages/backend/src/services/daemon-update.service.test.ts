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
});
