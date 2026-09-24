import 'reflect-metadata';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  list: vi.fn(async () => []),
  authType: 'session',
  scopes: [] as string[],
}));
vi.mock('@/container.js', () => ({
  container: { resolve: mocks.resolve },
  TOKENS: new Proxy({}, { get: (_target, key) => Symbol.for(String(key)) }),
}));
vi.mock('@/modules/auth/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/auth/auth.middleware.js')>();
  // Inject an authenticated boundary; keep the actual guards.
  const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
    c.set('user', { id: 'actor', scopes: ['integrations:hosting:manage', 'hosting:billing:view'] } as never);
    c.set('effectiveScopes', mocks.scopes);
    c.set('authType', mocks.authType as 'session');
    await next();
  };
  return { ...actual, authMiddleware };
});

import { hostingIntegrationRoutes, hostingRoutes } from './hosting.routes.js';

const id = '11111111-1111-4111-8111-111111111111';
const app = new Hono<AppEnv>()
  .onError(errorHandler)
  .route('/api/integrations/hosting', hostingIntegrationRoutes)
  .route('/api/hosting', hostingRoutes);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authType = 'session';
  mocks.scopes = [`integrations:hosting:view:${id}`];
  mocks.resolve.mockReturnValue({ list: mocks.list });
});
describe('hosting HTTP authorization boundary', () => {
  it('uses effective credential scopes, never the broader owner scopes, and returns raw JSON', async () => {
    const response = await app.request('/api/integrations/hosting');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(mocks.list).toHaveBeenCalledWith({ id: 'actor', scopes: mocks.scopes });
  });
  const managementRoutes = [
    ['POST', '/api/integrations/hosting'],
    ['POST', '/api/integrations/hosting/test'],
    ['POST', '/api/integrations/hosting/discover'],
    ['PUT', `/api/integrations/hosting/${id}`],
    ['DELETE', `/api/integrations/hosting/${id}`],
    ['POST', `/api/integrations/hosting/${id}/sync`],
    ['POST', `/api/integrations/hosting/${id}/test`],
    ['GET', `/api/integrations/hosting/${id}/configuration`],
    ['GET', `/api/integrations/hosting/${id}/adoption-candidates`],
    ['POST', `/api/integrations/hosting/${id}/adopt`],
    ['GET', `/api/integrations/hosting/${id}/account-summary`],
    ['POST', '/api/hosting/operations'],
    ['POST', `/api/hosting/operations/${id}/retry-install`],
    ['POST', `/api/hosting/operations/${id}/reconcile`],
    ['POST', `/api/hosting/resources/${id}/actions`],
  ];
  it.each([
    ['GET', 'finance'],
    ['GET', 'invoices/invoice1'],
    ['POST', 'topup'],
  ])('removes the old financial %s %s API', async (method, path) => {
    const response = await app.request(`/api/integrations/hosting/${id}/${path}`, { method });
    expect(response.status).toBe(410);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it.each(managementRoutes)('dispatches API and OAuth tokens to the scoped service: %s %s', async (method, path) => {
    mocks.resolve.mockReturnValue(new Proxy({}, { get: () => vi.fn(async () => ({})) }));
    for (const authType of ['api-token', 'oauth-token']) {
      mocks.authType = authType;
      mocks.resolve.mockClear();
      const response = await app.request(path, {
        method,
        ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: '{}' }),
      });
      expect(response.status).not.toBe(403);
      expect(mocks.resolve).toHaveBeenCalled();
    }
  });
  it('rejects malformed identifiers before calling a domain service', async () => {
    const response = await app.request('/api/hosting/operations/not-a-uuid');
    expect(response.status).toBe(400);
  });
});
