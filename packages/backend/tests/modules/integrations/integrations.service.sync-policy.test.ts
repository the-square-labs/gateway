import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import {
  BASE_USER,
  connectorRow,
  createCloudflareDeleteInUseDb,
  createDockerSourceListDb,
  createDockerSourceResolveDb,
  createGetDb,
  createGetUpdateDb,
  createListDb,
  createProjectActionDb,
  createToolProjectsDb,
  projectRow,
  vcsProvider,
} from './integrations.service.test-support.js';

describe('IntegrationsService', () => {


  it('allows selected GitLab projects by exact project or parent group allowlist', () => {
    const service = new IntegrationsService({} as never, { log: vi.fn() } as never, {} as never);
    const allowlist = [
      { entryType: 'project', remoteId: '10', fullPath: 'other/app', name: null, webUrl: null },
      { entryType: 'group', remoteId: '20', fullPath: 'org/platform', name: null, webUrl: null },
    ] as never;

    expect(service.isGitLabProjectAllowed({ remoteId: '10', fullPath: 'unrelated/path', name: 'app' }, allowlist)).toBe(
      true
    );
    expect(
      service.isGitLabProjectAllowed({ remoteId: '11', fullPath: 'org/platform/api', name: 'api' }, allowlist)
    ).toBe(true);
    expect(service.isGitLabProjectAllowed({ remoteId: '12', fullPath: 'org/other', name: 'other' }, allowlist)).toBe(
      false
    );
  });







  it('does not audit successful scheduled Cloudflare connector syncs', async () => {
    const db = createGetUpdateDb(
      connectorRow({ provider: 'cloudflare', name: 'Cloudflare', encryptedToken: JSON.stringify('encrypted-token') })
    );
    const auditService = { log: vi.fn() };
    const service = new IntegrationsService(
      db as never,
      auditService as never,
      { decryptString: vi.fn(() => 'cloudflare-token') } as never
    );
    vi.spyOn(service as any, 'testCloudflareToken').mockResolvedValue({ capabilities: { dnsEdit: true }, zones: [] });
    vi.spyOn(service as any, 'persistCloudflareZones').mockResolvedValue(undefined);

    await service.syncCloudflareConnector('11111111-1111-4111-8111-111111111111', null, { scheduled: true });

    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('reports an invalid Cloudflare token as an integration error instead of a session error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 1000, message: 'Invalid API Token' }],
          result: null,
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const service = new IntegrationsService({} as never, { log: vi.fn() } as never, {} as never);

    try {
      await expect((service as any).testCloudflareToken('invalid-token')).rejects.toMatchObject({
        statusCode: 400,
        code: 'CLOUDFLARE_TOKEN_INVALID',
        message: 'Cloudflare API token is invalid',
      } satisfies Partial<AppError>);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
