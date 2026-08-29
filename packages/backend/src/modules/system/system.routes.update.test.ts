import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const mocks = vi.hoisted(() => ({
  updateService: {
    getCachedStatus: vi.fn(),
    prepareGatewayUpdate: vi.fn(),
    prepareRelayUpdate: vi.fn(),
    performUpdate: vi.fn(),
    performRelayUpdate: vi.fn(),
    startRelayUpdate: vi.fn(),
    completeRelayUpdate: vi.fn(),
    failRelayUpdate: vi.fn(),
    checkForUpdates: vi.fn(),
  },
  eventBus: { publish: vi.fn() },
}));

vi.mock('@/container.js', () => ({
  TOKENS: {},
  container: {
    isRegistered: vi.fn().mockReturnValue(false),
    resolve: vi.fn((token) => (token?.name === 'EventBusService' ? mocks.eventBus : mocks.updateService)),
  },
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1' });
    c.set('effectiveScopes', ['admin:update']);
    await next();
  },
  requireScope: () => async (_c: any, next: () => Promise<void>) => next(),
  sessionOnly: async (_c: any, next: () => Promise<void>) => next(),
}));

import { systemRoutes } from './system.routes.js';

function app() {
  const router = new Hono<AppEnv>();
  router.onError(errorHandler);
  router.route('/', systemRoutes);
  return router;
}

describe('System RC update routes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.updateService.prepareGatewayUpdate.mockResolvedValue({ imageRef: 'gateway@sha256:test' });
    mocks.updateService.prepareRelayUpdate.mockResolvedValue({ imageRef: 'relay@sha256:test' });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('accepts a Gateway release candidate selected by the resolver', async () => {
    mocks.updateService.getCachedStatus.mockResolvedValue({
      updateAvailable: true,
      latestVersion: 'v2.10.0-rc.2',
      relay: { updateAvailable: false, latestVersion: null },
    });

    const response = await app().request('/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'v2.10.0-rc.2' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.updateService.prepareGatewayUpdate).toHaveBeenCalledWith('v2.10.0-rc.2');
  });

  it('accepts a Relay release candidate selected by the resolver', async () => {
    mocks.updateService.getCachedStatus.mockResolvedValue({
      updateAvailable: false,
      latestVersion: null,
      relay: { updateAvailable: true, latestVersion: 'v2.10.0-rc.3' },
    });

    const response = await app().request('/relay-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'v2.10.0-rc.3' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.updateService.prepareRelayUpdate).toHaveBeenCalledWith('v2.10.0-rc.3');
  });

  it('rejects component-suffixed versions on Gateway update routes', async () => {
    const response = await app().request('/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'v2.10.0-rc.2-nginx' }),
    });

    expect(response.status).toBe(400);
    expect(mocks.updateService.getCachedStatus).not.toHaveBeenCalled();
  });
});
