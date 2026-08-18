import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
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
  },
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn(() => mocks.proxyService),
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

function expectNoRawFields(value: unknown) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain('rawConfig');
  expect(serialized).not.toContain('rawConfigEnabled');
}

describe('proxy routes programmatic raw config handling', () => {
  beforeEach(() => {
    mocks.authType = 'api-token';
    mocks.scopes = ['proxy:view', 'proxy:create', 'proxy:view:host-1', 'proxy:edit:host-1', 'proxy:advanced:host-1'];
    vi.clearAllMocks();
    mocks.proxyService.listProxyHosts.mockResolvedValue({ data: [rawHost], total: 1 });
    mocks.proxyService.getProxyHost.mockResolvedValue(rawHost);
    mocks.proxyService.createProxyHost.mockResolvedValue(rawHost);
    mocks.proxyService.updateProxyHost.mockResolvedValue(rawHost);
    mocks.proxyService.toggleProxyHost.mockResolvedValue(rawHost);
    mocks.proxyService.toggleMaintenance.mockResolvedValue({ ...rawHost, maintenanceEnabled: true });
    mocks.proxyService.getRenderedConfig.mockResolvedValue('server {}');
    mocks.proxyService.validateAdvancedConfig.mockResolvedValue({ valid: true });
  });

  it('strips raw config fields from programmatic list and detail responses', async () => {
    const listResponse = await proxyRoutes.request('/', {
      headers: { Authorization: 'Bearer gw_token' },
    });
    const listBody = (await listResponse.json()) as { data: Array<Record<string, unknown>> };

    expect(listBody.data[0]).not.toHaveProperty('rawConfig');
    expect(listBody.data[0]).not.toHaveProperty('rawConfigEnabled');
    expectNoRawFields(listBody);

    const detailResponse = await proxyRoutes.request('/host-1', {
      headers: { Authorization: 'Bearer gw_token' },
    });
    const detailBody = (await detailResponse.json()) as { data: Record<string, unknown> };

    expect(detailBody.data).not.toHaveProperty('rawConfig');
    expect(detailBody.data).not.toHaveProperty('rawConfigEnabled');
    expectNoRawFields(detailBody);
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

  it('strips raw config fields from programmatic create update and toggle responses', async () => {
    const createResponse = await jsonRequest('POST', '/', {
      nodeId: '11111111-1111-4111-8111-111111111111',
      domainNames: ['app.example.com'],
      forwardHost: 'upstream',
      forwardPort: 8080,
    });
    const createBody = (await createResponse.json()) as { data: Record<string, unknown> };

    expect(createResponse.status).toBe(201);
    expectNoRawFields(createBody);

    const updateResponse = await jsonRequest('PUT', '/host-1', {
      forwardHost: 'upstream',
    });
    const updateBody = (await updateResponse.json()) as { data: Record<string, unknown> };

    expect(updateResponse.status).toBe(200);
    expectNoRawFields(updateBody);

    const toggleResponse = await jsonRequest('POST', '/host-1/toggle', {
      enabled: false,
    });
    const toggleBody = (await toggleResponse.json()) as { data: Record<string, unknown> };

    expect(toggleResponse.status).toBe(200);
    expectNoRawFields(toggleBody);
  });

  it('toggles maintenance through the resource-scoped edit endpoint', async () => {
    const response = await jsonRequest('POST', '/host-1/maintenance', { enabled: true });
    const body = (await response.json()) as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data.maintenanceEnabled).toBe(true);
    expect(mocks.proxyService.toggleMaintenance).toHaveBeenCalledWith('host-1', true, 'user-1');
  });

  it('rejects raw config create and update requests from programmatic auth', async () => {
    const createResponse = await jsonRequest('POST', '/', {
      type: 'raw',
      nodeId: '11111111-1111-4111-8111-111111111111',
      domainNames: ['raw.example.com'],
      forwardHost: 'upstream',
      forwardPort: 8080,
      rawConfig: 'server {}',
    });

    expect(createResponse.status).toBe(403);
    expect(mocks.proxyService.createProxyHost).not.toHaveBeenCalled();

    const updateResponse = await jsonRequest('PUT', '/host-1', {
      rawConfig: 'server {}',
    });

    expect(updateResponse.status).toBe(403);
    expect(mocks.proxyService.updateProxyHost).not.toHaveBeenCalled();
  });

  it('rejects raw config validation from programmatic auth', async () => {
    const response = await jsonRequest('POST', '/validate-config', {
      snippet: 'server {}',
      mode: 'raw',
    });

    expect(response.status).toBe(403);
    expect(mocks.proxyService.validateAdvancedConfig).not.toHaveBeenCalled();
  });

  it('rejects rendered raw config reads from programmatic auth', async () => {
    const response = await proxyRoutes.request('/host-1/rendered-config', {
      headers: { Authorization: 'Bearer gw_token' },
    });

    expect(response.status).toBe(403);
    expect(mocks.proxyService.getRenderedConfig).not.toHaveBeenCalled();
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
      expect.objectContaining({ upstreamKind: 'pages', pageProjectId }),
      'user-1',
      expect.any(Object)
    );
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
      body: JSON.stringify({ cacheEnabled: true }),
    });
    expect(denied.status).toBe(403);
    expect(mocks.proxyService.updateProxyHost).not.toHaveBeenCalled();

    mocks.scopes = ['proxy:edit:host-1', `pages:view:${pageProjectId}`];
    const allowed = await createApp().request('/host-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cacheEnabled: true }),
    });
    expect(allowed.status).toBe(200);
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
});
