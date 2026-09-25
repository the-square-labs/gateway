import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const CERT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CERT_ID = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  scopes: [] as string[],
  systemRows: [] as Array<{ isSystem: boolean }>,
  sslService: {
    resyncDistribution: vi.fn(),
  },
}));

vi.mock('@/container.js', () => ({
  TOKENS: { DrizzleClient: Symbol('DrizzleClient') },
  container: {
    resolve: vi.fn((token) => {
      // TOKENS.DrizzleClient: the resync check reads the certificate's isSystem flag.
      if (typeof token === 'symbol') {
        const limit = async () => mocks.systemRows;
        return { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) };
      }
      return mocks.sslService;
    }),
  },
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1', email: 'operator@wlt.sh' });
    c.set('effectiveScopes', mocks.scopes);
    await next();
  },
  requireScope: () => async (_c: any, next: () => Promise<void>) => next(),
  requireScopeBase: () => async (_c: any, next: () => Promise<void>) => next(),
  requireAnyScopeBase: () => async (_c: any, next: () => Promise<void>) => next(),
  requireScopeForResource: () => async (_c: any, next: () => Promise<void>) => next(),
}));

vi.mock('./ssl.service.js', () => ({ SSLService: class SSLService {} }));
vi.mock('./ssl-certificate-folders.service.js', () => ({
  SSLCertificateFolderService: class SSLCertificateFolderService {},
}));
vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn() }));

import { sslRoutes } from './ssl.routes.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', sslRoutes);
  return app;
}

function resync(id: string) {
  return createApp().request(`/${id}/distribution/resync`, { method: 'POST' });
}

describe('SSL certificate distribution resync authorization', () => {
  beforeEach(() => {
    mocks.scopes = [];
    mocks.systemRows = [{ isSystem: false }];
    vi.clearAllMocks();
    mocks.sslService.resyncDistribution.mockResolvedValue({ queued: 1 });
  });

  it('keeps system certificates on admin:update', async () => {
    mocks.systemRows = [{ isSystem: true }];

    mocks.scopes = ['ssl:cert:issue'];
    expect((await resync(CERT_ID)).status).toBe(403);
    expect(mocks.sslService.resyncDistribution).not.toHaveBeenCalled();

    mocks.scopes = ['admin:update'];
    expect((await resync(CERT_ID)).status).toBe(200);
  });

  it('allows the certificate issue grant for that certificate only', async () => {
    mocks.scopes = [`ssl:cert:issue:${CERT_ID}`];

    const allowed = await resync(CERT_ID);
    const denied = await resync(OTHER_CERT_ID);

    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
    expect(mocks.sslService.resyncDistribution).toHaveBeenCalledOnce();
    expect(mocks.sslService.resyncDistribution).toHaveBeenCalledWith(CERT_ID, 'user-1');
  });

  it('allows broad certificate issue access', async () => {
    mocks.scopes = ['ssl:cert:issue'];

    expect((await resync(CERT_ID)).status).toBe(200);
  });

  it('still accepts admin:update for one release', async () => {
    mocks.scopes = ['admin:update'];

    expect((await resync(CERT_ID)).status).toBe(200);
  });

  it('refuses view-only access', async () => {
    mocks.scopes = ['ssl:cert:view'];

    const response = await resync(CERT_ID);

    expect(response.status).toBe(403);
    expect(mocks.sslService.resyncDistribution).not.toHaveBeenCalled();
  });
});
