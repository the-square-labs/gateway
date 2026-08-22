import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const DOMAIN_ID = '11111111-1111-4111-8111-111111111111';

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
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token) => (token?.name === 'DomainsService' ? mocks.domainsService : mocks.sslService)),
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
    mocks.sslService.requestACMECert.mockResolvedValue({ id: 'cert-1' });
    mocks.domainsService.getNginxNodeOptions.mockResolvedValue({
      eligibleNodes: [],
      unconfiguredNodes: [],
      totalNginxNodes: 0,
      unconfiguredNginxNodes: 0,
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
      'user-1'
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
      },
      'user-1',
      'operator@wlt.sh'
    );
  });
});
