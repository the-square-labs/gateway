import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const mocks = vi.hoisted(() => ({
  scopes: [] as string[],
  service: {
    create: vi.fn(),
    update: vi.fn(),
    getById: vi.fn(),
    updateHostingRule: vi.fn(),
    reconcileRuleUpdate: vi.fn(),
    invalidateRuleCache: vi.fn(),
  },
}));
vi.mock('@/container.js', () => ({ container: { resolve: () => mocks.service } }));
vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', {
      id: 'user',
      scopes: ['notifications:alerts:manage', 'integrations:hosting:view', 'hosting:billing:view'],
    });
    c.set('effectiveScopes', mocks.scopes);
    await next();
  },
  requireAnyScope:
    (...required: string[]) =>
    async (c: any, next: () => Promise<void>) => {
      const { hasScope } = await import('@/lib/permissions.js');
      if (!required.some((scope) => hasScope(c.get('effectiveScopes') ?? [], scope))) {
        return c.json({ error: 'forbidden' }, 403);
      }
      await next();
    },
}));

import { alertRuleRoutes } from './notification-alert-rule.routes.js';

const body = {
  name: 'Balance',
  type: 'threshold',
  category: 'hosting_account',
  metric: 'balance',
  metricTarget: 'USD',
  operator: '<',
  thresholdValue: 10,
  resourceIds: ['account'],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.scopes = ['notifications:alerts:manage'];
  mocks.service.getById.mockResolvedValue(body);
  mocks.service.create.mockResolvedValue(body);
  mocks.service.update.mockResolvedValue(body);
  mocks.service.updateHostingRule.mockImplementation((_previous, update) => update());
});
it.each(['POST', 'PUT'])('checks effective hosting finance access on %s rather than owner scopes', async (method) => {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', alertRuleRoutes);
  const path = method === 'POST' ? '/' : '/11111111-1111-4111-8111-111111111111';
  const request = () =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect((await request()).status).toBe(403);
  expect(mocks.service.create).not.toHaveBeenCalled();
  expect(mocks.service.update).not.toHaveBeenCalled();
  mocks.scopes = ['notifications:alerts:manage', 'integrations:hosting:view:account', 'hosting:billing:view:account'];
  expect((await request()).status).toBe(method === 'POST' ? 201 : 200);
});

it('resolves firing states orphaned by disabling or re-scoping a non-hosting rule', async () => {
  const previous = {
    ...body,
    id: 'rule-1',
    category: 'proxy',
    type: 'event',
    eventPattern: 'health.offline',
    enabled: true,
    resourceIds: ['a', 'b'],
  };
  const next = { ...previous, enabled: false };
  mocks.service.getById.mockResolvedValue(previous);
  mocks.service.update.mockResolvedValue(next);
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', alertRuleRoutes);

  const response = await app.request('/11111111-1111-4111-8111-111111111111', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });

  expect(response.status).toBe(200);
  expect(mocks.service.updateHostingRule).not.toHaveBeenCalled();
  expect(mocks.service.reconcileRuleUpdate).toHaveBeenCalledWith(previous, next);
});

it.each([
  [['notifications:alerts:view'], 403],
  [['notifications:webhooks:manage'], 403],
])('refuses alert rule creation with %j', async (scopes, status) => {
  mocks.scopes = scopes;
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', alertRuleRoutes);

  const response = await app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, category: 'proxy', type: 'event', eventPattern: 'health.offline' }),
  });

  expect(response.status).toBe(status);
  expect(mocks.service.create).not.toHaveBeenCalled();
});
