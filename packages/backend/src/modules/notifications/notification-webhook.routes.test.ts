import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const WEBHOOK_ID = '44444444-4444-4444-8444-444444444444';

const mocks = vi.hoisted(() => {
  class NotificationWebhookService {}
  class NotificationDispatcherService {}
  return {
    NotificationWebhookService,
    NotificationDispatcherService,
    scopes: [] as string[],
    webhookService: { list: vi.fn(), getById: vi.fn() },
  };
});

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token: unknown) => {
      if (token === mocks.NotificationWebhookService) return mocks.webhookService;
      return {};
    }),
  },
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1' });
    c.set('effectiveScopes', mocks.scopes);
    await next();
  },
  requireAnyScope: () => async (_c: any, next: () => Promise<void>) => next(),
}));

vi.mock('./notification-webhook.service.js', () => ({ NotificationWebhookService: mocks.NotificationWebhookService }));
vi.mock('./notification-dispatcher.service.js', () => ({
  NotificationDispatcherService: mocks.NotificationDispatcherService,
}));

import { webhookRoutes } from './notification-webhook.routes.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', webhookRoutes);
  return app;
}

function responseWebhook(revealSensitive: boolean) {
  return {
    id: WEBHOOK_ID,
    url: revealSensitive ? 'https://hooks.example.test/services/secret-token' : 'https://hooks.example.test/********',
    headers: revealSensitive ? { Authorization: 'Bearer secret' } : { Authorization: '********' },
  };
}

describe('notification webhook secret visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopes = [];
    mocks.webhookService.list.mockImplementation((_query, options) =>
      Promise.resolve({
        data: [responseWebhook(options?.revealHeaders === true && options?.revealUrl === true)],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      })
    );
    mocks.webhookService.getById.mockImplementation((_id, options) =>
      Promise.resolve(responseWebhook(options?.revealHeaders === true && options?.revealUrl === true))
    );
  });

  it.each([
    ['viewer', ['notifications:webhooks:view'], false],
    ['editor', ['notifications:webhooks:edit'], true],
    ['manager', ['notifications:manage'], true],
  ])('passes %s secret visibility to list and detail reads', async (_role, scopes, revealSensitive) => {
    mocks.scopes = scopes;
    const app = createApp();

    const listResponse = await app.request('/');
    const detailResponse = await app.request(`/${WEBHOOK_ID}`);

    expect(listResponse.status).toBe(200);
    expect(detailResponse.status).toBe(200);
    expect(mocks.webhookService.list).toHaveBeenCalledWith(expect.any(Object), {
      revealHeaders: revealSensitive,
      revealUrl: revealSensitive,
    });
    expect(mocks.webhookService.getById).toHaveBeenCalledWith(WEBHOOK_ID, {
      revealHeaders: revealSensitive,
      revealUrl: revealSensitive,
    });
    const listBody = JSON.stringify(await listResponse.json());
    const detailBody = JSON.stringify(await detailResponse.json());
    expect(listBody).toContain(revealSensitive ? 'Bearer secret' : '********');
    expect(detailBody).toContain(revealSensitive ? 'Bearer secret' : '********');
    expect(listBody).toContain(revealSensitive ? 'secret-token' : '/********');
    expect(detailBody).toContain(revealSensitive ? 'secret-token' : '/********');
  });
});
