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
  it('does not fake provider-backed actions before a provider is registered', async () => {
    const db = createGetDb(connectorRow());
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);

    await expect(service.testGitLabConnector('11111111-1111-4111-8111-111111111111', 'user-1')).rejects.toMatchObject({
      statusCode: 501,
      code: 'CONNECTOR_PROVIDER_UNAVAILABLE',
    } satisfies Partial<AppError>);
  });

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

  it('rejects manual sync while a connector sync is already running', async () => {
    const db = createGetUpdateDb(connectorRow({ syncStatus: 'running', syncStartedAt: new Date(Date.now() - 1000) }));
    const service = new IntegrationsService(db as never, { log: vi.fn() } as never, {} as never);

    await expect(service.syncGitLabConnector('11111111-1111-4111-8111-111111111111', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONNECTOR_SYNC_RUNNING',
    });
  });

  it('does not audit successful scheduled GitLab connector syncs', async () => {
    const db = createGetUpdateDb(connectorRow({ encryptedToken: JSON.stringify('encrypted-token') }));
    const auditService = { log: vi.fn() };
    const service = new IntegrationsService(
      db as never,
      auditService as never,
      { decryptString: vi.fn(() => 'gitlab-token') } as never
    );
    service.registerProvider({
      provider: 'gitlab',
      testConnection: vi.fn().mockResolvedValue({ projectsView: true }),
      listProjects: vi.fn().mockResolvedValue([]),
      listRegistries: vi.fn().mockResolvedValue({ registries: [], skippedProjects: [] }),
    } as never);
    vi.spyOn(service as any, 'listAllowlistRows').mockResolvedValue([]);
    vi.spyOn(service as any, 'persistProjects').mockResolvedValue(undefined);
    vi.spyOn(service as any, 'persistRegistries').mockResolvedValue(undefined);

    await service.syncGitLabConnector('11111111-1111-4111-8111-111111111111', null, { scheduled: true });

    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('keeps project sync available without Personal and leaves existing discovered registries untouched', async () => {
    const db = createGetUpdateDb(connectorRow({ encryptedToken: JSON.stringify('encrypted-token') }));
    const service = new IntegrationsService(
      db as never,
      { log: vi.fn() } as never,
      { decryptString: vi.fn(() => 'gitlab-token') } as never
    );
    const provider = {
      provider: 'gitlab',
      testConnection: vi.fn().mockResolvedValue({ projectsView: true }),
      listProjects: vi.fn().mockResolvedValue([]),
      listRegistries: vi.fn(),
    };
    service.registerProvider(provider as never);
    service.setLicensePolicyService({ hasFeature: vi.fn().mockResolvedValue(false) } as never);
    vi.spyOn(service as any, 'listAllowlistRows').mockResolvedValue([]);
    const persistProjects = vi.spyOn(service as any, 'persistProjects').mockResolvedValue(undefined);
    const persistRegistries = vi.spyOn(service as any, 'persistRegistries').mockResolvedValue(undefined);

    await expect(
      service.syncGitLabConnector('11111111-1111-4111-8111-111111111111', null, { scheduled: true })
    ).resolves.toMatchObject({ status: 'success', projectCount: 0, registryCount: 0 });

    expect(persistProjects).toHaveBeenCalledOnce();
    expect(provider.listRegistries).not.toHaveBeenCalled();
    expect(persistRegistries).not.toHaveBeenCalled();
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
