import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const DOMAIN_ID = '11111111-1111-4111-8111-111111111111';
const FOLDER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_FOLDER_ID = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  scopes: [] as string[],
  domainsService: {
    previewDomain: vi.fn(),
    createDomain: vi.fn(),
    updateDomain: vi.fn(),
    deleteDomain: vi.fn(),
    getDomain: vi.fn(),
    getNginxNodeOptions: vi.fn(),
    resolveCloudflareMigration: vi.fn(),
  },
  sslService: {
    requestACMECert: vi.fn(),
  },
  folderService: {
    assertFolderExists: vi.fn(),
    moveFolder: vi.fn(),
  },
  sslFolderService: {
    assertFolderExists: vi.fn(),
  },
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token) => {
      if (token?.name === 'DomainsService') return mocks.domainsService;
      if (token?.name === 'DomainFolderService') return mocks.folderService;
      if (token?.name === 'SSLCertificateFolderService') return mocks.sslFolderService;
      return mocks.sslService;
    }),
  },
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1', email: 'operator@wlt.sh' });
    c.set('effectiveScopes', mocks.scopes);
    await next();
  },
  requireScope: (scope: string) => async (c: any, next: () => Promise<void>) => {
    if (!mocks.scopes.includes(scope)) {
      return c.json({ code: 'FORBIDDEN', message: `Missing required scope: ${scope}` }, 403);
    }
    await next();
  },
  requireScopeBase: (scope: string) => async (c: any, next: () => Promise<void>) => {
    if (!mocks.scopes.some((candidate) => candidate === scope || candidate.startsWith(`${scope}:`))) {
      return c.json({ code: 'FORBIDDEN', message: `Missing required scope: ${scope}` }, 403);
    }
    await next();
  },
  requireAnyScopeBase:
    (...scopes: string[]) =>
    async (c: any, next: () => Promise<void>) => {
      if (
        !scopes.some((scope) =>
          mocks.scopes.some((candidate) => candidate === scope || candidate.startsWith(`${scope}:`))
        )
      ) {
        return c.json({ code: 'FORBIDDEN', message: 'Missing required scope' }, 403);
      }
      await next();
    },
  requireScopeForResource: (scope: string, param: string) => async (c: any, next: () => Promise<void>) => {
    const resourceScope = `${scope}:${c.req.param(param)}`;
    if (!mocks.scopes.includes(scope) && !mocks.scopes.includes(resourceScope)) {
      return c.json({ code: 'FORBIDDEN', message: `Missing required scope: ${resourceScope}` }, 403);
    }
    await next();
  },
}));

vi.mock('@/modules/domains/domain-folders.service.js', () => ({
  DomainFolderService: class DomainFolderService {},
}));
vi.mock('@/modules/ssl/ssl.service.js', () => ({ SSLService: class SSLService {} }));
const grantCreatedResourcePermissions = vi.hoisted(() => vi.fn());
vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions }));
vi.mock('@/modules/ssl/ssl-certificate-folders.service.js', () => ({
  SSLCertificateFolderService: class SSLCertificateFolderService {},
}));
vi.mock('./domain.service.js', () => ({ DomainsService: class DomainsService {} }));

import { domainRoutes } from './domain.routes.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', domainRoutes);
  return app;
}

function request(method: string, path: string, body?: unknown) {
  return createApp().request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('domain routes authorization', () => {
  beforeEach(() => {
    mocks.scopes = [];
    vi.clearAllMocks();
    mocks.domainsService.previewDomain.mockResolvedValue({ domain: 'example.com' });
    mocks.domainsService.createDomain.mockResolvedValue({ id: DOMAIN_ID, domain: 'example.com' });
    mocks.domainsService.updateDomain.mockResolvedValue({ id: DOMAIN_ID, domain: 'example.com', dnsProxied: true });
    mocks.domainsService.deleteDomain.mockResolvedValue(undefined);
    mocks.domainsService.getDomain.mockResolvedValue({
      id: DOMAIN_ID,
      domain: 'example.com',
      dnsProvider: 'cloudflare',
    });
    mocks.domainsService.resolveCloudflareMigration.mockResolvedValue({
      id: DOMAIN_ID,
      domain: 'example.com',
      dnsProvider: 'legacy',
      cloudflareMigrationStatus: 'ignored',
    });
    mocks.sslService.requestACMECert.mockResolvedValue({ certificate: { id: 'cert-1' }, status: 'active' });
    mocks.folderService.assertFolderExists.mockResolvedValue(undefined);
    mocks.sslFolderService.assertFolderExists.mockResolvedValue(undefined);
    mocks.domainsService.getNginxNodeOptions.mockResolvedValue({
      eligibleNodes: [],
      unconfiguredNodes: [],
      totalNginxNodes: 0,
      unconfiguredNginxNodes: 0,
    });
  });

  it('checks domains:edit on every moved domain when a folder is moved', async () => {
    mocks.scopes = ['domains:folders:manage', `domains:edit:folder/${OTHER_FOLDER_ID}`];
    mocks.folderService.moveFolder.mockResolvedValue({ id: FOLDER_ID });

    const response = await request('PUT', `/folders/${FOLDER_ID}/move`, { parentId: OTHER_FOLDER_ID });

    expect(response.status).toBe(200);
    expect(mocks.folderService.moveFolder).toHaveBeenCalledWith(FOLDER_ID, { parentId: OTHER_FOLDER_ID }, 'user-1', {
      scopes: mocks.scopes,
      editScope: 'domains:edit',
    });
  });

  it('uses domains:edit for manual Cloudflare migration resolution', async () => {
    mocks.scopes = ['domains:edit'];

    const response = await request('POST', `/${DOMAIN_ID}/cloudflare-migration/resolve`, {
      action: 'keep_external',
    });

    expect(response.status).toBe(200);
    expect(mocks.domainsService.resolveCloudflareMigration).toHaveBeenCalledWith(
      DOMAIN_ID,
      { action: 'keep_external' },
      'user-1',
      ['domains:edit']
    );
  });

  it('does not accept a Cloudflare-only scope for domain creation', async () => {
    mocks.scopes = ['integrations:cloudflare:manage'];

    const response = await request('POST', '/', { domain: 'example.com' });

    expect(response.status).toBe(403);
    expect(mocks.domainsService.createDomain).not.toHaveBeenCalled();
  });

  it('uses domains:create for DNS preview and domain creation', async () => {
    mocks.scopes = ['domains:create'];

    const preview = await request('POST', '/preview', { domain: 'example.com' });
    const created = await request('POST', '/', { domain: 'example.com' });

    expect(preview.status).toBe(200);
    expect(created.status).toBe(201);
    expect(mocks.domainsService.previewDomain).toHaveBeenCalledWith({
      domain: 'example.com',
      dnsProvider: 'cloudflare',
    });
    expect(mocks.domainsService.createDomain).toHaveBeenCalledWith(
      { domain: 'example.com', dnsProvider: 'cloudflare' },
      'user-1'
    );
  });

  it('authorizes creation only for the selected folder and validates it before invoking the domain service', async () => {
    mocks.scopes = [`domains:create:folder/${FOLDER_ID}`];

    const response = await request('POST', '/', { domain: 'example.com', folderId: FOLDER_ID });

    expect(response.status).toBe(201);
    expect(mocks.folderService.assertFolderExists).toHaveBeenCalledWith(FOLDER_ID);
    expect(mocks.domainsService.createDomain).toHaveBeenCalledWith(
      { domain: 'example.com', dnsProvider: 'cloudflare', folderId: FOLDER_ID },
      'user-1'
    );
  });

  it('rejects root and unrelated folder creation grants before the domain service is called', async () => {
    mocks.scopes = [`domains:create:folder/${FOLDER_ID}`];

    const root = await request('POST', '/', { domain: 'root.example.com' });
    const unrelated = await request('POST', '/', { domain: 'other.example.com', folderId: OTHER_FOLDER_ID });

    expect(root.status).toBe(403);
    expect(unrelated.status).toBe(403);
    expect(mocks.folderService.assertFolderExists).not.toHaveBeenCalled();
    expect(mocks.domainsService.createDomain).not.toHaveBeenCalled();
  });

  it('retains broad creation access and stops before external domain creation when the folder is missing', async () => {
    mocks.scopes = ['domains:create'];
    mocks.folderService.assertFolderExists.mockRejectedValue(new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found'));

    const response = await request('POST', '/', { domain: 'example.com', folderId: FOLDER_ID });

    expect(response.status).toBe(404);
    expect(mocks.domainsService.createDomain).not.toHaveBeenCalled();
  });

  it('creates on the only ingress node of a node-limited grant when nginxNodeId is omitted', async () => {
    const NODE_A = '55555555-5555-4555-8555-555555555555';
    const NODE_B = '66666666-6666-4666-8666-666666666666';
    mocks.domainsService.getNginxNodeOptions.mockResolvedValue({
      eligibleNodes: [
        { id: NODE_A, hostname: 'edge-a', displayName: null },
        { id: NODE_B, hostname: 'edge-b', displayName: null },
      ],
      unconfiguredNodes: [],
      totalNginxNodes: 2,
      unconfiguredNginxNodes: 0,
    });

    mocks.scopes = [`domains:create:node/${NODE_B}`];
    const created = await request('POST', '/', { domain: 'example.com' });
    expect(created.status).toBe(201);
    expect(mocks.domainsService.createDomain).toHaveBeenCalledWith(
      { domain: 'example.com', dnsProvider: 'cloudflare', nginxNodeId: NODE_B },
      'user-1'
    );

    mocks.scopes = [`domains:create:node/${NODE_A}`, `domains:create:node/${NODE_B}`];
    const ambiguous = await request('POST', '/', { domain: 'other.example.com' });
    expect(ambiguous.status).toBe(409);
    await expect(ambiguous.json()).resolves.toMatchObject({
      code: 'DOMAIN_NGINX_NODE_REQUIRED',
      details: { eligibleNodes: [{ id: NODE_A }, { id: NODE_B }] },
    });
    expect(mocks.domainsService.createDomain).toHaveBeenCalledOnce();
  });

  it('uses domains:create for the domain Nginx node options', async () => {
    mocks.scopes = ['domains:create'];

    const response = await request('GET', '/nginx-nodes');

    expect(response.status).toBe(200);
    expect(mocks.domainsService.getNginxNodeOptions).toHaveBeenCalledOnce();
  });

  it('allows a domains:edit user to change the managed DNS proxy setting', async () => {
    mocks.scopes = ['domains:edit'];

    const response = await request('PUT', `/${DOMAIN_ID}`, { proxied: true });

    expect(response.status).toBe(200);
    expect(mocks.domainsService.updateDomain).toHaveBeenCalledWith(DOMAIN_ID, { proxied: true }, 'user-1');
  });

  it('limits domain edits to the selected resource', async () => {
    mocks.scopes = [`domains:edit:${DOMAIN_ID}`];

    const allowed = await request('PUT', `/${DOMAIN_ID}`, { proxied: true });
    const denied = await request('PUT', '/22222222-2222-4222-8222-222222222222', { proxied: true });

    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
  });

  it('uses domains:delete for managed DNS deletion without a Cloudflare-specific scope', async () => {
    mocks.scopes = ['domains:delete'];

    const response = await request('DELETE', `/${DOMAIN_ID}`, { deleteDns: true });

    expect(response.status).toBe(200);
    expect(mocks.domainsService.deleteDomain).toHaveBeenCalledWith(DOMAIN_ID, 'user-1', { deleteDns: true });
  });

  it('uses Cloudflare DNS-01 when issuing a certificate for a managed domain', async () => {
    mocks.scopes = ['domains:edit', 'ssl:cert:issue'];

    const response = await request('POST', `/${DOMAIN_ID}/issue-cert`);

    expect(response.status).toBe(201);
    expect(mocks.sslService.requestACMECert).toHaveBeenCalledWith(
      {
        domains: ['example.com'],
        challengeType: 'dns-01',
        provider: 'letsencrypt',
        autoRenew: true,
        dnsProvider: 'cloudflare',
        folderId: null,
      },
      'user-1',
      'operator@wlt.sh'
    );
    // Like every other certificate creation, the issuer keeps sight of the new certificate.
    expect(grantCreatedResourcePermissions).toHaveBeenCalledWith('user-1', 'ssl:cert', 'cert-1', { folderId: null });
  });

  it('lets a folder-only creator load the Nginx node options and preview DNS', async () => {
    mocks.scopes = [`domains:create:folder/${FOLDER_ID}`];
    mocks.domainsService.getNginxNodeOptions.mockResolvedValue({
      eligibleNodes: [{ id: 'node-a' }, { id: 'node-b' }],
      unconfiguredNodes: [{ id: 'node-c' }],
      totalNginxNodes: 3,
      unconfiguredNginxNodes: 1,
    });

    const nodes = await request('GET', '/nginx-nodes');
    const preview = await request('POST', '/preview', { domain: 'example.com' });

    expect(nodes.status).toBe(200);
    expect(((await nodes.json()) as { data: { eligibleNodes: unknown[] } }).data.eligibleNodes).toHaveLength(2);
    expect(preview.status).toBe(200);
  });

  it('limits the Nginx node options to the ingress nodes of node-only creation grants', async () => {
    const NODE_A = '44444444-4444-4444-8444-444444444444';
    mocks.scopes = [`domains:create:node/${NODE_A}`];
    mocks.domainsService.getNginxNodeOptions.mockResolvedValue({
      eligibleNodes: [{ id: NODE_A }, { id: 'node-b' }],
      unconfiguredNodes: [{ id: 'node-c' }],
      totalNginxNodes: 3,
      unconfiguredNginxNodes: 1,
    });

    const response = await request('GET', '/nginx-nodes');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { eligibleNodes: [{ id: NODE_A }], unconfiguredNodes: [], totalNginxNodes: 1, unconfiguredNginxNodes: 0 },
    });
  });

  it('previews DNS for node-only creators only on a node of their grant', async () => {
    const NODE_A = '44444444-4444-4444-8444-444444444444';
    const NODE_B = '55555555-5555-4555-8555-555555555555';
    mocks.scopes = [`domains:create:node/${NODE_A}`];

    const own = await request('POST', '/preview', { domain: 'example.com', nginxNodeId: NODE_A });
    const other = await request('POST', '/preview', { domain: 'example.com', nginxNodeId: NODE_B });
    const implicit = await request('POST', '/preview', { domain: 'example.com' });

    expect(own.status).toBe(200);
    expect(other.status).toBe(403);
    expect(implicit.status).toBe(403);
    expect(mocks.domainsService.previewDomain).toHaveBeenCalledOnce();
  });

  it('refuses the creation helpers without any domains:create grant', async () => {
    mocks.scopes = ['domains:view'];

    expect((await request('GET', '/nginx-nodes')).status).toBe(403);
    expect((await request('POST', '/preview', { domain: 'example.com' })).status).toBe(403);
  });

  it('issues a domain certificate into a granted SSL certificate folder', async () => {
    mocks.scopes = [`domains:edit:${DOMAIN_ID}`, `ssl:cert:issue:folder/${FOLDER_ID}`];

    const root = await request('POST', `/${DOMAIN_ID}/issue-cert`);
    const otherFolder = await request('POST', `/${DOMAIN_ID}/issue-cert`, { folderId: OTHER_FOLDER_ID });
    const allowed = await request('POST', `/${DOMAIN_ID}/issue-cert`, { folderId: FOLDER_ID });

    expect(root.status).toBe(403);
    expect(otherFolder.status).toBe(403);
    expect(allowed.status).toBe(201);
    expect(mocks.sslFolderService.assertFolderExists).toHaveBeenCalledWith(FOLDER_ID);
    expect(mocks.sslService.requestACMECert).toHaveBeenCalledOnce();
    expect(mocks.sslService.requestACMECert).toHaveBeenCalledWith(
      expect.objectContaining({ domains: ['example.com'], folderId: FOLDER_ID }),
      'user-1',
      'operator@wlt.sh'
    );
  });

  it('does not issue a domain certificate with only a per-certificate issue grant', async () => {
    mocks.scopes = [`domains:edit:${DOMAIN_ID}`, 'ssl:cert:issue:55555555-5555-4555-8555-555555555555'];

    const response = await request('POST', `/${DOMAIN_ID}/issue-cert`);

    expect(response.status).toBe(403);
    expect(mocks.sslService.requestACMECert).not.toHaveBeenCalled();
  });
});
