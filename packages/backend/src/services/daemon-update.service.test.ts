import { describe, expect, it } from 'vitest';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  DaemonUpdateService,
  isStableDaemonReleaseTag,
  selectLatestStableDaemonRelease,
} from './daemon-update.service.js';

describe('DaemonUpdateService release selection', () => {
  it('accepts only stable tags for the matching daemon type', () => {
    expect(isStableDaemonReleaseTag('v2.5.0-nginx', 'nginx')).toBe(true);
    expect(isStableDaemonReleaseTag('v2.5.0-nginx-rc.1', 'nginx')).toBe(false);
    expect(isStableDaemonReleaseTag('v2.5.0-docker', 'nginx')).toBe(false);
  });

  it('ignores newer release candidates when selecting a stable update', () => {
    const latest = selectLatestStableDaemonRelease(
      [
        { tag_name: 'v3.0.0-nginx-rc.2', description: 'candidate', _links: { self: 'candidate' } },
        { tag_name: 'v2.9.0-nginx', description: 'stable', _links: { self: 'stable' } },
      ],
      'nginx'
    );

    expect(latest?.tag_name).toBe('v2.9.0-nginx');
    expect(latest?.version).toBe('v2.9.0');
  });
});

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
});
