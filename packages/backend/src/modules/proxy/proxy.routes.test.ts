import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const mocks = vi.hoisted(() => ({
  authType: 'api-token' as 'api-token' | 'session',
  scopes: ['proxy:view', 'proxy:create', 'proxy:view:host-1', 'proxy:edit:host-1', 'proxy:advanced:host-1'],
  proxyService: {
    listProxyHosts: vi.fn(),
    getProxyHost: vi.fn(),
    createProxyHost: vi.fn(),
    updateProxyHost: vi.fn(),
    toggleProxyHost: vi.fn(),
    toggleMaintenance: vi.fn(),
    getProxyHostHealthHistory: vi.fn(),
    getRenderedConfig: vi.fn(),
    validateAdvancedConfig: vi.fn(),
    deleteProxyHost: vi.fn(),
    create: vi.fn(),
    present: vi.fn(),
    createAdditionalSecureLink: vi.fn(),
    assertReferenceAccess: vi.fn(),
  },
  licensePolicy: {
    requireFeature: vi.fn(),
  },
  pageProfile: { requireEnabled: vi.fn() },
  folderService: { assertFolderExists: vi.fn() },
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token) => {
      if (token?.name === 'LicensePolicyService') return mocks.licensePolicy;
      if (token?.name === 'PageProfileService') return mocks.pageProfile;
      if (token?.name === 'FolderService') return mocks.folderService;
      return mocks.proxyService;
    }),
  },
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1' });
    c.set('effectiveScopes', mocks.scopes);
    c.set('authType', mocks.authType);
    await next();
  },
  isProgrammaticAuth: (c: any) => c.get('authType') === 'api-token' || c.get('authType') === 'oauth-token',
  requireScope: () => async (_c: any, next: () => Promise<void>) => next(),
  requireScopeBase: () => async (_c: any, next: () => Promise<void>) => next(),
  requireScopeForResource: () => async (_c: any, next: () => Promise<void>) => next(),
  sessionOnly: async (c: any, next: () => Promise<void>) => {
    if (c.get('authType') !== 'session') {
      return c.json({ message: 'This endpoint requires browser session authentication.' }, 403);
    }
    await next();
  },
}));

vi.mock('./proxy.service.js', () => ({
  ProxyService: class ProxyService {},
}));

import { proxyRoutes } from './proxy.routes.js';

const rawHost = {
  id: 'host-1',
  domainNames: ['app.example.com'],
  rawConfig: 'server {}',
  rawConfigEnabled: true,
};

function jsonRequest(method: string, path: string, body: unknown) {
  return proxyRoutes.request(path, {
    method,
    headers: {
      Authorization: 'Bearer gw_token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', proxyRoutes);
  return app;
}

describe('proxy routes programmatic raw config handling', () => {
  beforeEach(() => {
    mocks.authType = 'api-token';
    mocks.scopes = ['proxy:view', 'proxy:create', 'proxy:view:host-1', 'proxy:edit:host-1', 'proxy:advanced:host-1'];
    vi.clearAllMocks();
    mocks.licensePolicy.requireFeature.mockResolvedValue(undefined);
    mocks.pageProfile.requireEnabled.mockResolvedValue(undefined);
    mocks.folderService.assertFolderExists.mockResolvedValue(undefined);
    mocks.proxyService.listProxyHosts.mockResolvedValue({ data: [rawHost], total: 1 });
    mocks.proxyService.getProxyHost.mockResolvedValue(rawHost);
    mocks.proxyService.createProxyHost.mockResolvedValue(rawHost);
    mocks.proxyService.updateProxyHost.mockResolvedValue(rawHost);
    mocks.proxyService.toggleProxyHost.mockResolvedValue(rawHost);
    mocks.proxyService.toggleMaintenance.mockResolvedValue({ ...rawHost, maintenanceEnabled: true });
    mocks.proxyService.getRenderedConfig.mockResolvedValue('server {}');
    mocks.proxyService.validateAdvancedConfig.mockResolvedValue({ valid: true });
    mocks.proxyService.create.mockResolvedValue({ id: 'route-1' });
    mocks.proxyService.present.mockResolvedValue({ id: 'route-1' });
    mocks.proxyService.assertReferenceAccess.mockResolvedValue(undefined);
  });

  it('applies the same scope-based raw config visibility to programmatic list and detail responses', async () => {
    const { rawConfig: _rawConfig, ...listedHost } = rawHost;
    mocks.proxyService.listProxyHosts.mockResolvedValue({ data: [listedHost], total: 1 });
    const listResponse = await proxyRoutes.request('/', {
      headers: { Authorization: 'Bearer gw_token' },
    });
    const listBody = (await listResponse.json()) as { data: Array<Record<string, unknown>> };

    expect(listResponse.status).toBe(200);
    expect(listBody.data[0]).toEqual(listedHost);

    const detailResponse = await proxyRoutes.request('/host-1', {
      headers: { Authorization: 'Bearer gw_token' },
    });
    const detailBody = (await detailResponse.json()) as { data: Record<string, unknown> };

    expect(detailBody.data.rawConfig).toBeNull();
    expect(detailBody.data.rawConfigEnabled).toBe(true);

    mocks.scopes = [...mocks.scopes, 'proxy:raw:read:host-1'];
    const rawDetail = await proxyRoutes.request('/host-1', {
      headers: { Authorization: 'Bearer gw_token' },
    });

    expect(((await rawDetail.json()) as { data: Record<string, unknown> }).data.rawConfig).toBe('server {}');
  });

  it('accepts a managed S3 destination without Docker fields and forwards effective scopes', async () => {
    const managedStorageId = '11111111-1111-4111-8111-111111111111';
    mocks.proxyService.createAdditionalSecureLink.mockResolvedValue({ id: 'binding-1' });
    const response = await jsonRequest('POST', '/host-1/additional-secure-links', {
      name: 'storage',
      upstreamKind: 'managed_storage',
      managedStorageId,
    });
    expect(response.status).toBe(201);
    expect(mocks.proxyService.createAdditionalSecureLink).toHaveBeenCalledWith(
      'host-1',
      {
        name: 'storage',
        upstreamKind: 'managed_storage',
        managedStorageId,
        forwardScheme: 'http',
      },
      'user-1',
      mocks.scopes
    );
  });

  it.each([
    { name: 'storage', upstreamKind: 'managed_storage' },
    {
      name: 'docker',
      upstreamKind: 'docker_container',
      dockerNodeId: '11111111-1111-4111-8111-111111111111',
      dockerContainerName: 'api',
    },
  ])('rejects incomplete additional Secure Link inputs %j', async (body) => {
    const response = await createApp().request('/host-1/additional-secure-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(mocks.proxyService.createAdditionalSecureLink).not.toHaveBeenCalled();
  });

  it('requires advanced scope when creating an Additional Route with advanced config', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:edit:host-1'];

    const response = await createApp().request('/host-1/additional-routes', {
      method: 'POST',
      headers: { Authorization: 'Bearer gw_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/api',
        targetKind: 'manual',
        forwardHost: 'upstream',
        forwardPort: 8080,
        advancedConfig: 'proxy_set_header X-Test yes;',
      }),
    });

    expect(response.status).toBe(403);
    expect(mocks.proxyService.create).not.toHaveBeenCalled();
  });

  it('validates an authorized route folder before creating a proxy host', async () => {
    const folderId = '22222222-2222-4222-8222-222222222222';
    mocks.authType = 'session';
    mocks.scopes = [`proxy:create:folder/${folderId}`];

    const response = await createApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'proxy',
        upstreamKind: 'manual',
        nodeId: '44444444-4444-4444-8444-444444444444',
        domainNames: ['app.example.com'],
        forwardHost: 'upstream.example.test',
        forwardPort: 8080,
        forwardScheme: 'http',
        folderId,
      }),
    });

    expect(response.status).toBe(201);
    expect(mocks.folderService.assertFolderExists).toHaveBeenCalledWith(folderId);
    expect(mocks.proxyService.createProxyHost).toHaveBeenCalledWith(
      expect.objectContaining({ folderId }),
      'user-1',
      expect.any(Object)
    );
  });

  it('redacts raw config from browser detail response without raw read scope', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:view:host-1'];

    const response = await createApp().request('/host-1', {
      headers: { Authorization: 'Bearer gw_token' },
    });
    const body = (await response.json()) as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data.rawConfig).toBeNull();
    expect(body.data.rawConfigEnabled).toBe(true);
  });

  it('does not disclose a Pages target without visibility of its Project', async () => {
    const projectId = '22222222-2222-4222-8222-222222222222';
    mocks.authType = 'session';
    mocks.proxyService.getProxyHost.mockResolvedValue({
      ...rawHost,
      upstreamKind: 'pages',
      pageTarget: { projectId, tagId: 'tag-1', deploymentId: 'deployment-1', status: 'ready' },
    });
    mocks.scopes = ['proxy:view:host-1'];

    const hidden = await createApp().request('/host-1');
    expect(((await hidden.json()) as any).data.pageTarget).toBeNull();

    mocks.scopes = ['proxy:view:host-1', `pages:view:${projectId}`];
    const visible = await createApp().request('/host-1');
    expect(((await visible.json()) as any).data.pageTarget).toEqual(expect.objectContaining({ projectId }));
  });

  it('returns raw config to browser detail response with raw read scope', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:view:host-1', 'proxy:raw:read:host-1'];

    const response = await createApp().request('/host-1', {
      headers: { Authorization: 'Bearer gw_token' },
    });
    const body = (await response.json()) as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data.rawConfig).toBe('server {}');
    expect(body.data.rawConfigEnabled).toBe(true);
  });

  it('redacts raw config from browser write and toggle responses without explicit raw read scope', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:create', 'proxy:raw:write'];

    const createResponse = await createApp().request('/', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer gw_token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        nodeId: '11111111-1111-4111-8111-111111111111',
        domainNames: ['raw.example.com'],
        forwardHost: 'upstream',
        forwardPort: 8080,
        rawConfig: 'server {}',
      }),
    });
    const createBody = (await createResponse.json()) as { data: Record<string, unknown> };

    expect(createResponse.status).toBe(201);
    expect(createBody.data.rawConfig).toBeNull();
    expect(createBody.data.rawConfigEnabled).toBe(true);

    mocks.scopes = ['proxy:edit:host-1', 'proxy:raw:write:host-1'];
    const updateResponse = await createApp().request('/host-1', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer gw_token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        rawConfig: 'server {}',
      }),
    });
    const updateBody = (await updateResponse.json()) as { data: Record<string, unknown> };

    expect(updateResponse.status).toBe(200);
    expect(updateBody.data.rawConfig).toBeNull();
    expect(updateBody.data.rawConfigEnabled).toBe(true);

    mocks.scopes = ['proxy:edit:host-1'];
    const toggleResponse = await createApp().request('/host-1/toggle', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer gw_token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: false }),
    });
    const toggleBody = (await toggleResponse.json()) as { data: Record<string, unknown> };

    expect(toggleResponse.status).toBe(200);
    expect(toggleBody.data.rawConfig).toBeNull();
    expect(toggleBody.data.rawConfigEnabled).toBe(true);
  });

  it('redacts raw config from programmatic create update and toggle responses without raw read scope', async () => {
    const createResponse = await jsonRequest('POST', '/', {
      nodeId: '11111111-1111-4111-8111-111111111111',
      domainNames: ['app.example.com'],
      forwardHost: 'upstream',
      forwardPort: 8080,
    });
    const createBody = (await createResponse.json()) as { data: Record<string, unknown> };

    expect(createResponse.status).toBe(201);
    expect(createBody.data.rawConfig).toBeNull();

    const updateResponse = await jsonRequest('PUT', '/host-1', {
      forwardHost: 'upstream',
    });
    const updateBody = (await updateResponse.json()) as { data: Record<string, unknown> };

    expect(updateResponse.status).toBe(200);
    expect(updateBody.data.rawConfig).toBeNull();

    const toggleResponse = await jsonRequest('POST', '/host-1/toggle', {
      enabled: false,
    });
    const toggleBody = (await toggleResponse.json()) as { data: Record<string, unknown> };

    expect(toggleResponse.status).toBe(200);
    expect(toggleBody.data.rawConfig).toBeNull();
  });

  it('toggles maintenance through the resource-scoped edit endpoint', async () => {
    const response = await jsonRequest('POST', '/host-1/maintenance', { enabled: true });
    const body = (await response.json()) as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data.maintenanceEnabled).toBe(true);
    expect(mocks.proxyService.toggleMaintenance).toHaveBeenCalledWith('host-1', true, 'user-1');
  });

  it('gates programmatic raw config create and update requests by raw scopes only', async () => {
    const rawCreate = {
      type: 'raw',
      nodeId: '11111111-1111-4111-8111-111111111111',
      domainNames: ['raw.example.com'],
      forwardHost: 'upstream',
      forwardPort: 8080,
      rawConfig: 'server {}',
    };
    const createResponse = await createApp().request('/', {
      method: 'POST',
      headers: { Authorization: 'Bearer gw_token', 'Content-Type': 'application/json' },
      body: JSON.stringify(rawCreate),
    });

    expect(createResponse.status).toBe(403);
    expect(mocks.proxyService.createProxyHost).not.toHaveBeenCalled();

    const updateResponse = await createApp().request('/host-1', {
      method: 'PUT',
      headers: { Authorization: 'Bearer gw_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawConfig: 'server {}' }),
    });

    expect(updateResponse.status).toBe(403);
    expect(mocks.proxyService.updateProxyHost).not.toHaveBeenCalled();

    mocks.scopes = [...mocks.scopes, 'proxy:raw:toggle', 'proxy:raw:write', 'proxy:raw:read'];
    const allowedCreate = await jsonRequest('POST', '/', rawCreate);
    const allowedCreateBody = (await allowedCreate.json()) as { data: Record<string, unknown> };

    expect(allowedCreate.status).toBe(201);
    expect(allowedCreateBody.data.rawConfig).toBe('server {}');
    expect(mocks.proxyService.createProxyHost).toHaveBeenCalledWith(
      expect.objectContaining({ rawConfig: 'server {}' }),
      'user-1',
      expect.any(Object)
    );

    const allowedUpdate = await jsonRequest('PUT', '/host-1', { rawConfig: 'server {}' });

    expect(allowedUpdate.status).toBe(200);
    expect(mocks.proxyService.updateProxyHost).toHaveBeenCalledWith(
      'host-1',
      expect.objectContaining({ rawConfig: 'server {}' }),
      'user-1',
      expect.any(Object)
    );
  });

  it('validates raw config from programmatic auth with raw write scope', async () => {
    const denied = await createApp().request('/validate-config', {
      method: 'POST',
      headers: { Authorization: 'Bearer gw_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ snippet: 'server {}', mode: 'raw' }),
    });

    expect(denied.status).toBe(403);
    expect(mocks.proxyService.validateAdvancedConfig).not.toHaveBeenCalled();

    mocks.scopes = ['proxy:raw:write:host-1'];
    const response = await jsonRequest('POST', '/validate-config', {
      snippet: 'server {}',
      mode: 'raw',
      proxyHostId: 'host-1',
    });

    expect(response.status).toBe(200);
    expect(mocks.proxyService.validateAdvancedConfig).toHaveBeenCalledWith('server {}', true, false, false);
  });

  it('reads rendered raw config from programmatic auth only with raw read scope', async () => {
    const denied = await proxyRoutes.request('/host-1/rendered-config', {
      headers: { Authorization: 'Bearer gw_token' },
    });

    expect(denied.status).toBe(403);
    expect(mocks.proxyService.getRenderedConfig).not.toHaveBeenCalled();

    mocks.scopes = ['proxy:raw:read:host-1'];
    const response = await proxyRoutes.request('/host-1/rendered-config', {
      headers: { Authorization: 'Bearer gw_token' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { rendered: 'server {}' } });
  });

  it('requires explicit raw read scope for rendered raw config reads', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:raw:write:host-1'];

    const response = await createApp().request('/host-1/rendered-config', {
      headers: { Authorization: 'Bearer gw_token' },
    });

    expect(response.status).toBe(403);
    expect(mocks.proxyService.getRenderedConfig).not.toHaveBeenCalled();
  });

  it('allows browser raw config validation with raw write scope', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:raw:write:host-1'];

    const response = await createApp().request('/validate-config', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer gw_token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: 'server {}',
        mode: 'raw',
        proxyHostId: 'host-1',
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.proxyService.validateAdvancedConfig).toHaveBeenCalledWith('server {}', true, false, false);
  });

  it('passes raw bypass only when browser session has proxy raw bypass scope', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:raw:write:host-1', 'proxy:raw:bypass:host-1'];

    const response = await createApp().request('/validate-config', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer gw_token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: 'include /etc/nginx/conf.d/private.conf;',
        mode: 'raw',
        proxyHostId: 'host-1',
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.proxyService.validateAdvancedConfig).toHaveBeenCalledWith(
      'include /etc/nginx/conf.d/private.conf;',
      true,
      false,
      true
    );
  });

  it('does not let proxy advanced bypass bypass raw validation', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:raw:write:host-1', 'proxy:advanced:bypass:host-1'];

    const response = await createApp().request('/validate-config', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer gw_token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: 'include /etc/nginx/conf.d/private.conf;',
        mode: 'raw',
        proxyHostId: 'host-1',
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.proxyService.validateAdvancedConfig).toHaveBeenCalledWith(
      'include /etc/nginx/conf.d/private.conf;',
      true,
      false,
      false
    );
  });

  it('does not let raw bypass alone grant raw validation access', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:raw:bypass:host-1'];

    const response = await createApp().request('/validate-config', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer gw_token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: 'include /etc/nginx/conf.d/private.conf;',
        mode: 'raw',
        proxyHostId: 'host-1',
      }),
    });

    expect(response.status).toBe(403);
    expect(mocks.proxyService.validateAdvancedConfig).not.toHaveBeenCalled();
  });

  it('passes raw bypass to service when creating a host with raw config', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:create', 'proxy:raw:write', 'proxy:raw:bypass'];

    const response = await createApp().request('/', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer gw_token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        nodeId: '11111111-1111-4111-8111-111111111111',
        domainNames: ['raw.example.com'],
        forwardHost: 'upstream',
        forwardPort: 8080,
        rawConfig: 'include /etc/nginx/conf.d/private.conf;',
      }),
    });

    expect(response.status).toBe(201);
    expect(mocks.proxyService.createProxyHost).toHaveBeenCalledWith(
      expect.objectContaining({ rawConfig: 'include /etc/nginx/conf.d/private.conf;' }),
      'user-1',
      expect.objectContaining({
        bypassAdvancedValidation: false,
        bypassRawValidation: true,
      })
    );
  });

  it('requires visibility of the selected Page Project when creating a Pages Route', async () => {
    const pageProjectId = '22222222-2222-4222-8222-222222222222';
    const body = {
      nodeId: '11111111-1111-4111-8111-111111111111',
      domainNames: ['docs.example.com'],
      upstreamKind: 'pages',
      pageProjectId,
      pageTagId: '33333333-3333-4333-8333-333333333333',
      healthCheckEnabled: true,
    };
    mocks.scopes = ['proxy:create'];
    const denied = await createApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(denied.status).toBe(403);
    expect(mocks.proxyService.createProxyHost).not.toHaveBeenCalled();

    mocks.scopes = ['proxy:create', `pages:view:${pageProjectId}`];
    const allowed = await createApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(allowed.status).toBe(201);
    expect(mocks.proxyService.createProxyHost).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamKind: 'pages', pageProjectId, healthCheckEnabled: true }),
      'user-1',
      expect.any(Object)
    );
  });

  it('returns the standard entitlement denial before creating a Pages Route', async () => {
    const pageProjectId = '22222222-2222-4222-8222-222222222222';
    mocks.scopes = ['proxy:create', `pages:view:${pageProjectId}`];
    mocks.licensePolicy.requireFeature.mockRejectedValueOnce(
      new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'A higher license plan is required', {
        feature: 'pages',
        requiredPlan: 'personal',
      })
    );

    const response = await createApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: '11111111-1111-4111-8111-111111111111',
        domainNames: ['docs.example.com'],
        upstreamKind: 'pages',
        pageProjectId,
        pageTagId: '33333333-3333-4333-8333-333333333333',
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'LICENSE_ENTITLEMENT_REQUIRED',
      details: { feature: 'pages', requiredPlan: 'personal' },
    });
    expect(mocks.licensePolicy.requireFeature).toHaveBeenCalledWith('pages');
    expect(mocks.proxyService.createProxyHost).not.toHaveBeenCalled();
  });

  it('requires visibility of the current Page Project when editing a Pages Route', async () => {
    const pageProjectId = '22222222-2222-4222-8222-222222222222';
    mocks.authType = 'session';
    mocks.proxyService.getProxyHost.mockResolvedValue({
      ...rawHost,
      upstreamKind: 'pages',
      pageTarget: { projectId: pageProjectId },
    });
    mocks.scopes = ['proxy:edit:host-1'];

    const denied = await createApp().request('/host-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cacheEnabled: true, healthCheckEnabled: true }),
    });
    expect(denied.status).toBe(403);
    expect(mocks.proxyService.updateProxyHost).not.toHaveBeenCalled();

    mocks.scopes = ['proxy:edit:host-1', `pages:view:${pageProjectId}`];
    const allowed = await createApp().request('/host-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cacheEnabled: true, healthCheckEnabled: true }),
    });
    expect(allowed.status).toBe(200);
    expect(mocks.proxyService.updateProxyHost).toHaveBeenCalledWith(
      'host-1',
      expect.objectContaining({ cacheEnabled: true, healthCheckEnabled: true }),
      'user-1',
      expect.any(Object)
    );
  });

  it('allows switching an existing Pages Route to another target after entitlement loss', async () => {
    const pageProjectId = '22222222-2222-4222-8222-222222222222';
    mocks.authType = 'session';
    mocks.proxyService.getProxyHost.mockResolvedValue({
      ...rawHost,
      upstreamKind: 'pages',
      pageTarget: { projectId: pageProjectId },
    });
    mocks.scopes = ['proxy:edit:host-1', `pages:view:${pageProjectId}`];
    mocks.licensePolicy.requireFeature.mockRejectedValueOnce(
      new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'A higher license plan is required')
    );

    const response = await createApp().request('/host-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        upstreamKind: 'manual',
        forwardHost: 'backend.internal',
        forwardPort: 8080,
        forwardScheme: 'http',
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.licensePolicy.requireFeature).not.toHaveBeenCalled();
    expect(mocks.proxyService.updateProxyHost).toHaveBeenCalledOnce();
  });

  it('passes resource-scoped raw bypass to service when updating raw config', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:edit:host-1', 'proxy:raw:write:host-1', 'proxy:raw:bypass:host-1'];

    const response = await createApp().request('/host-1', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer gw_token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        rawConfig: 'include /etc/nginx/conf.d/private.conf;',
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.proxyService.updateProxyHost).toHaveBeenCalledWith(
      'host-1',
      expect.objectContaining({ rawConfig: 'include /etc/nginx/conf.d/private.conf;' }),
      'user-1',
      expect.objectContaining({
        bypassAdvancedValidation: false,
        bypassRawValidation: true,
      })
    );
  });

  it('allows browser raw-only updates with raw write scope and without proxy edit scope', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:raw:write:host-1'];

    const response = await createApp().request('/host-1', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer gw_token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        rawConfig: 'server {}',
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.proxyService.updateProxyHost).toHaveBeenCalledWith(
      'host-1',
      expect.objectContaining({ rawConfig: 'server {}' }),
      'user-1',
      expect.objectContaining({
        bypassAdvancedValidation: false,
        bypassRawValidation: false,
      })
    );
  });

  it('passes explicit nulls through when clearing access list and advanced config', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:edit:host-1', 'proxy:advanced:host-1'];

    const response = await createApp().request('/host-1', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer gw_token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accessListId: null,
        advancedConfig: null,
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.proxyService.updateProxyHost).toHaveBeenCalledWith(
      'host-1',
      expect.objectContaining({
        accessListId: null,
        advancedConfig: null,
      }),
      'user-1',
      expect.objectContaining({
        bypassAdvancedValidation: false,
        bypassRawValidation: false,
      })
    );
  });

  it('does not allow raw-only permission to update normal proxy settings', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:raw:write:host-1'];

    const response = await createApp().request('/host-1', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer gw_token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        rawConfig: 'server {}',
        forwardHost: 'other-upstream',
      }),
    });

    expect(response.status).toBe(403);
    expect(mocks.proxyService.updateProxyHost).not.toHaveBeenCalled();
  });

  it('requires raw write scope when a browser session creates a host with raw config', async () => {
    mocks.authType = 'session';

    const response = await createApp().request('/', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer gw_token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        nodeId: '11111111-1111-4111-8111-111111111111',
        domainNames: ['raw.example.com'],
        forwardHost: 'upstream',
        forwardPort: 8080,
        rawConfig: 'server {}',
      }),
    });

    expect(response.status).toBe(403);
    expect(mocks.proxyService.createProxyHost).not.toHaveBeenCalled();
  });

  it('requires raw toggle scope when a browser session creates a raw-typed host', async () => {
    mocks.authType = 'session';

    const response = await createApp().request('/', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer gw_token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'raw',
        nodeId: '11111111-1111-4111-8111-111111111111',
        domainNames: ['raw.example.com'],
      }),
    });

    expect(response.status).toBe(403);
    expect(mocks.proxyService.createProxyHost).not.toHaveBeenCalled();
  });

  function sessionPut(body: unknown) {
    return createApp().request('/host-1', {
      method: 'PUT',
      headers: { Authorization: 'Bearer gw_token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('does not require raw toggle scope when an edit echoes the unchanged raw mode', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:view', 'proxy:edit:host-1'];
    mocks.proxyService.getProxyHost.mockResolvedValue({
      id: 'host-1',
      type: 'proxy',
      nodeId: 'node-1',
      rawConfigEnabled: false,
      advancedConfig: null,
    });

    const unchanged = await sessionPut({ domainNames: ['app.example.com'], rawConfigEnabled: false, type: 'proxy' });
    expect(unchanged.status).toBe(200);

    const toggled = await sessionPut({ rawConfigEnabled: true });
    expect(toggled.status).toBe(403);
    expect(mocks.proxyService.updateProxyHost).toHaveBeenCalledTimes(1);
  });

  it('treats the redacted rawConfig null echoed by a caller without raw read as absent', async () => {
    mocks.scopes = ['proxy:view', 'proxy:edit:host-1'];
    const put = (body: unknown) =>
      createApp().request('/host-1', {
        method: 'PUT',
        headers: { Authorization: 'Bearer gw_token', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const echoed = await put({
      domainNames: ['app.example.com'],
      rawConfig: null,
      rawConfigEnabled: true,
    });
    expect(echoed.status).toBe(200);
    expect(mocks.proxyService.updateProxyHost).toHaveBeenCalledWith(
      'host-1',
      expect.objectContaining({ domainNames: ['app.example.com'] }),
      'user-1',
      expect.any(Object)
    );
    expect(mocks.proxyService.updateProxyHost.mock.calls[0]?.[1]).not.toHaveProperty('rawConfig');

    // A caller who can read the raw config and clears it still needs raw write access.
    mocks.scopes = ['proxy:view', 'proxy:edit:host-1', 'proxy:raw:read:host-1'];
    const cleared = await put({ rawConfig: null });
    expect(cleared.status).toBe(403);
    expect(mocks.proxyService.updateProxyHost).toHaveBeenCalledTimes(1);
  });

  it('applies the move endpoint checks to a folderId change and ignores an unchanged folderId', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:view', 'proxy:edit:host-1'];
    mocks.proxyService.getProxyHost.mockResolvedValue({ id: 'host-1', type: 'proxy', folderId: null });

    const moved = await sessionPut({ folderId: '22222222-2222-4222-8222-222222222222' });
    expect(moved.status).toBe(403);
    expect(mocks.proxyService.updateProxyHost).not.toHaveBeenCalled();

    mocks.proxyService.getProxyHost.mockResolvedValue({
      id: 'host-1',
      type: 'proxy',
      folderId: '22222222-2222-4222-8222-222222222222',
    });
    const unchanged = await sessionPut({ folderId: '22222222-2222-4222-8222-222222222222', forwardPort: 8080 });
    expect(unchanged.status).toBe(200);
    expect(mocks.proxyService.updateProxyHost.mock.calls[0]?.[1]).not.toHaveProperty('folderId');

    mocks.scopes = ['proxy:view', 'proxy:edit', 'proxy:folders:manage'];
    const allowed = await sessionPut({ folderId: '33333333-3333-4333-8333-333333333333' });
    expect(allowed.status).toBe(200);
    expect(mocks.folderService.assertFolderExists).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333');
  });

  it('redacts advanced config from view responses without proxy:advanced scope', async () => {
    mocks.authType = 'session';
    mocks.proxyService.getProxyHost.mockResolvedValue({ id: 'host-1', advancedConfig: 'add_header X-Secret 1;' });

    mocks.scopes = ['proxy:view:host-1'];
    const hidden = await createApp().request('/host-1', { headers: { Authorization: 'Bearer gw_token' } });
    expect(((await hidden.json()) as any).data.advancedConfig).toBeNull();

    mocks.scopes = ['proxy:view:host-1', 'proxy:advanced:host-1'];
    const visible = await createApp().request('/host-1', { headers: { Authorization: 'Bearer gw_token' } });
    expect(((await visible.json()) as any).data.advancedConfig).toBe('add_header X-Secret 1;');

    mocks.scopes = ['proxy:view'];
    mocks.proxyService.listProxyHosts.mockResolvedValue({
      data: [{ id: 'host-1', advancedConfig: 'add_header X-Secret 1;' }],
      total: 1,
    });
    const list = await createApp().request('/', { headers: { Authorization: 'Bearer gw_token' } });
    expect(((await list.json()) as any).data[0].advancedConfig).toBeNull();
  });

  it('does not let a scope-less edit clear or replace the stored advanced config', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:view', 'proxy:edit:host-1'];
    mocks.proxyService.getProxyHost.mockResolvedValue({
      id: 'host-1',
      type: 'proxy',
      advancedConfig: 'add_header X-Secret 1;',
    });

    const echoedRedacted = await sessionPut({ advancedConfig: null, forwardPort: 8080 });
    expect(echoedRedacted.status).toBe(200);
    expect(mocks.proxyService.updateProxyHost.mock.calls[0]?.[1]).not.toHaveProperty('advancedConfig');

    const replaced = await sessionPut({ advancedConfig: 'add_header X-Other 1;' });
    expect(replaced.status).toBe(403);
  });

  it('checks access to referenced resources with the stored values', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:view', 'proxy:edit:host-1'];
    const existing = { id: 'host-1', type: 'proxy', sslCertificateId: null, accessListId: null };
    mocks.proxyService.getProxyHost.mockResolvedValue(existing);
    mocks.proxyService.assertReferenceAccess.mockRejectedValueOnce(
      new AppError(403, 'FORBIDDEN', 'Viewing the selected access list is required')
    );

    const response = await sessionPut({ accessListId: '44444444-4444-4444-8444-444444444444' });

    expect(response.status).toBe(403);
    expect(mocks.proxyService.assertReferenceAccess).toHaveBeenCalledWith(
      mocks.scopes,
      expect.objectContaining({ accessListId: '44444444-4444-4444-8444-444444444444' }),
      existing
    );
    expect(mocks.proxyService.updateProxyHost).not.toHaveBeenCalled();
  });
});
