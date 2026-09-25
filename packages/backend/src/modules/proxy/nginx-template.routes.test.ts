import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const mocks = vi.hoisted(() => ({
  authType: 'api-token' as 'api-token' | 'session',
  scopes: ['proxy:templates:view'],
  templateService: {
    listTemplates: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    cloneTemplate: vi.fn(),
    renderTemplate: vi.fn(),
    previewWithSampleData: vi.fn(),
  },
  proxyService: {
    getProxyHost: vi.fn(),
  },
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token) => {
      const tokenName = typeof token === 'function' ? token.name : String(token);
      return tokenName === 'ProxyService' ? mocks.proxyService : mocks.templateService;
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
  requireScope: (scope: string) => async (c: any, next: () => Promise<void>) => {
    const { hasScope } = await import('@/lib/permissions.js');
    if (!hasScope(mocks.scopes, scope)) return c.json({ message: `Missing required scope: ${scope}` }, 403);
    await next();
  },
  requireScopeBase: (scope: string) => async (c: any, next: () => Promise<void>) => {
    const { hasScopeBase } = await import('@/lib/permissions.js');
    if (!hasScopeBase(mocks.scopes, scope)) return c.json({ message: `Missing required scope: ${scope}` }, 403);
    await next();
  },
  requireScopeForResource: (scope: string, param: string) => async (c: any, next: () => Promise<void>) => {
    const { hasScope } = await import('@/lib/permissions.js');
    const required = `${scope}:${c.req.param(param)}`;
    if (!hasScope(mocks.scopes, required)) return c.json({ message: `Missing required scope: ${required}` }, 403);
    await next();
  },
  sessionOnly: async (c: any, next: () => Promise<void>) => {
    if (c.get('authType') !== 'session') {
      return c.json({ message: 'This endpoint requires browser session authentication.' }, 403);
    }
    await next();
  },
}));

vi.mock('./nginx-template.service.js', () => ({
  NginxTemplateService: class NginxTemplateService {},
}));

vi.mock('./proxy.service.js', () => ({
  ProxyService: class ProxyService {},
}));

import { nginxTemplateRoutes } from './nginx-template.routes.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', nginxTemplateRoutes);
  return app;
}

describe('nginx template routes', () => {
  beforeEach(() => {
    mocks.authType = 'api-token';
    mocks.scopes = ['proxy:templates:view'];
    vi.clearAllMocks();
    mocks.templateService.listTemplates.mockResolvedValue([{ id: 'template-1', name: 'Default' }]);
    mocks.templateService.createTemplate.mockResolvedValue({ id: 'template-2', name: 'Custom' });
    mocks.templateService.updateTemplate.mockResolvedValue({ id: 'template-1', name: 'Updated' });
    mocks.templateService.cloneTemplate.mockResolvedValue({ id: 'clone-1', name: 'Default Copy' });
    mocks.templateService.renderTemplate.mockReturnValue('rendered');
    mocks.templateService.previewWithSampleData.mockReturnValue('sample');
    mocks.proxyService.getProxyHost.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      type: 'proxy',
      domainNames: ['app.example.com'],
      enabled: true,
      forwardHost: 'app',
      forwardPort: 3000,
      forwardScheme: 'http',
      sslEnabled: false,
      sslForced: false,
      http2Support: true,
      websocketSupport: false,
      redirectUrl: null,
      redirectStatusCode: 301,
      customHeaders: [],
      cacheEnabled: false,
      cacheOptions: null,
      rateLimitEnabled: false,
      rateLimitOptions: null,
      customRewrites: [],
      advancedConfig: 'proxy_set_header X-Secret value;',
    });
  });

  it('allows programmatic access with proxy template scopes', async () => {
    const response = await nginxTemplateRoutes.request('/', {
      headers: { Authorization: 'Bearer gw_token' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ id: 'template-1', name: 'Default' }] });
  });

  it('writes template content with proxy:templates:manage and without proxy:raw:write', async () => {
    const input = { name: 'Custom', type: 'proxy', content: 'server {}' };
    const create = () =>
      createApp().request('/', {
        method: 'POST',
        headers: { Authorization: 'Bearer gw_token', 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });

    mocks.scopes = ['proxy:raw:write'];
    expect((await create()).status).toBe(403);
    mocks.scopes = ['proxy:templates:manage:template-1'];
    expect((await create()).status).toBe(403);
    expect(mocks.templateService.createTemplate).not.toHaveBeenCalled();

    mocks.scopes = ['proxy:templates:manage'];
    expect((await create()).status).toBe(201);
    expect(mocks.templateService.createTemplate).toHaveBeenCalledTimes(1);
  });

  it('updates only the templates covered by a resource-scoped manage grant', async () => {
    mocks.scopes = ['proxy:templates:manage:template-1'];
    const update = (id: string) =>
      createApp().request(`/${id}`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer gw_token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'server {}' }),
      });

    expect((await update('template-1')).status).toBe(200);
    expect((await update('template-2')).status).toBe(403);
    expect(mocks.templateService.updateTemplate).toHaveBeenCalledTimes(1);
  });

  it('requires broad manage scope when cloning a template', async () => {
    mocks.scopes = ['proxy:templates:view', 'proxy:templates:manage:template-1'];

    const denied = await createApp().request('/template-1/clone', {
      method: 'POST',
      headers: { Authorization: 'Bearer gw_token' },
    });

    expect(denied.status).toBe(403);
    expect(mocks.templateService.cloneTemplate).not.toHaveBeenCalled();

    mocks.scopes = ['proxy:templates:view', 'proxy:templates:manage'];
    const allowed = await createApp().request('/template-1/clone', {
      method: 'POST',
      headers: { Authorization: 'Bearer gw_token' },
    });

    expect(allowed.status).toBe(201);
    expect(await allowed.json()).toEqual({ data: { id: 'clone-1', name: 'Default Copy' } });
  });

  it('redacts host advanced config from previews without proxy advanced scope', async () => {
    mocks.scopes = ['proxy:templates:view', 'proxy:view:11111111-1111-4111-8111-111111111111'];

    const response = await createApp().request('/preview', {
      method: 'POST',
      headers: { Authorization: 'Bearer gw_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '{{{advancedConfig}}}', hostId: '11111111-1111-4111-8111-111111111111' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.templateService.renderTemplate).toHaveBeenCalledWith(
      '{{{advancedConfig}}}',
      expect.objectContaining({ advancedConfig: null })
    );
  });

  it('includes host advanced config in previews with proxy advanced scope', async () => {
    mocks.scopes = [
      'proxy:templates:view',
      'proxy:view:11111111-1111-4111-8111-111111111111',
      'proxy:advanced:11111111-1111-4111-8111-111111111111',
    ];

    const response = await createApp().request('/preview', {
      method: 'POST',
      headers: { Authorization: 'Bearer gw_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '{{{advancedConfig}}}', hostId: '11111111-1111-4111-8111-111111111111' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.templateService.renderTemplate).toHaveBeenCalledWith(
      '{{{advancedConfig}}}',
      expect.objectContaining({ advancedConfig: 'proxy_set_header X-Secret value;' })
    );
  });

  it('does not let a resource-scoped manage grant test unrelated new template content', async () => {
    mocks.authType = 'session';
    mocks.scopes = ['proxy:templates:manage:11111111-1111-4111-8111-111111111111', 'proxy:raw:write'];

    const response = await createApp().request('/test', {
      method: 'POST',
      headers: { Authorization: 'Bearer gw_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'server {}' }),
    });

    expect(response.status).toBe(403);
  });
});
