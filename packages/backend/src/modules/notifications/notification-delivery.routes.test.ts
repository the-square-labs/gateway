import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const DELIVERY_ID = '55555555-5555-4555-8555-555555555555';

const mocks = vi.hoisted(() => {
  class NotificationDeliveryService {}
  return {
    NotificationDeliveryService,
    scopes: [] as string[],
    deliveryService: { getById: vi.fn() },
  };
});

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token: unknown) => {
      if (token === mocks.NotificationDeliveryService) return mocks.deliveryService;
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

vi.mock('./notification-delivery.service.js', () => ({
  NotificationDeliveryService: mocks.NotificationDeliveryService,
}));

import { deliveryRoutes } from './notification-delivery.routes.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', deliveryRoutes);
  return app;
}

describe('notification delivery secret visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopes = [];
    mocks.deliveryService.getById.mockResolvedValue({ id: DELIVERY_ID });
  });

  it.each([
    ['viewer', ['notifications:deliveries:view'], false],
    ['notification viewer', ['notifications:view'], false],
    ['manager', ['notifications:manage'], true],
  ])('passes %s secret visibility to detail reads', async (_role, scopes, revealSensitive) => {
    mocks.scopes = scopes;

    const response = await createApp().request(`/${DELIVERY_ID}`);

    expect(response.status).toBe(200);
    expect(mocks.deliveryService.getById).toHaveBeenCalledWith(DELIVERY_ID, { revealSensitive });
  });
});
