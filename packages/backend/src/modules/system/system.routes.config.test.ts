import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const mocks = vi.hoisted(() => ({
  scopes: [] as string[],
  generalSettings: {
    getConfig: vi.fn(),
  },
  loggingFeature: {
    isEnabled: vi.fn(),
  },
}));

vi.mock('@/container.js', () => ({
  TOKENS: {},
  container: {
    isRegistered: vi.fn().mockReturnValue(false),
    resolve: vi.fn((token) =>
      token?.name === 'GeneralSettingsService' ? mocks.generalSettings : mocks.loggingFeature
    ),
  },
}));

vi.mock('@/modules/auth/auth.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/auth/auth.middleware.js')>();
  return {
    ...actual,
    authMiddleware: async (c: any, next: () => Promise<void>) => {
      c.set('user', { id: 'user-1' });
      c.set('effectiveScopes', mocks.scopes);
      await next();
    },
  };
});

const { systemRoutes } = await import('./system.routes.js');

function app() {
  const router = new Hono<AppEnv>();
  router.onError(errorHandler);
  router.route('/', systemRoutes);
  return router;
}

describe('system config projection', () => {
  beforeEach(() => {
    mocks.scopes = [];
    mocks.loggingFeature.isEnabled.mockReturnValue(true);
    mocks.generalSettings.getConfig.mockResolvedValue({
      fileUploadMaxBytes: 100,
      fileOpenMaxBytes: 10,
      gatewayGrpcPublicTarget: 'gateway.example.test:9443',
      gatewayGrpcLocalIp: '10.0.0.2:9443',
      relayAutoRecovery: true,
      relay: { dataLanes: 4 },
      features: { pkiEnabled: true },
    });
  });

  it('keeps UI-safe limits and features but redacts operational metadata without scope', async () => {
    const response = await app().request('/config');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        fileUploadMaxBytes: 100,
        fileOpenMaxBytes: 10,
        gatewayGrpcPublicTarget: null,
        gatewayGrpcLocalIp: null,
        relayAutoRecovery: false,
        features: { pkiEnabled: true, loggingEnabled: true },
      },
    });
  });

  it('preserves the complete operational projection with settings view scope', async () => {
    mocks.scopes = ['settings:gateway:view'];
    const response = await app().request('/config');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        gatewayGrpcPublicTarget: 'gateway.example.test:9443',
        gatewayGrpcLocalIp: '10.0.0.2:9443',
        relayAutoRecovery: true,
        relay: { dataLanes: 4 },
      },
    });
  });
});
