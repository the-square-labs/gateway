import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const UUID = '11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => ({
  scopes: [] as string[],
  service: {
    get: vi.fn(),
    getOptions: vi.fn(),
    configure: vi.fn(),
  },
  licensePolicy: { requireFeature: vi.fn() },
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token) => (token?.name === 'LicensePolicyService' ? mocks.licensePolicy : mocks.service)),
  },
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1', email: 'operator@example.test' });
    c.set('effectiveScopes', mocks.scopes);
    await next();
  },
  requireScope: (scope: string) => async (c: any, next: () => Promise<void>) => {
    if (!mocks.scopes.includes(scope)) return c.json({ code: 'FORBIDDEN', message: 'Forbidden' }, 403);
    await next();
  },
}));

import { pageProfileRoutes } from './page-profile.routes.js';

function app() {
  const result = new Hono<AppEnv>();
  result.onError(errorHandler);
  result.route('/', pageProfileRoutes);
  return result;
}

describe('Pages wildcard profile authorization', () => {
  beforeEach(() => {
    mocks.scopes = [];
    vi.clearAllMocks();
    mocks.service.get.mockResolvedValue({ enabled: false, status: 'disabled' });
    mocks.service.getOptions.mockResolvedValue({ domains: [], nodes: [], certificates: [] });
    mocks.service.configure.mockResolvedValue({ enabled: true, status: 'ready' });
  });

  it('requires the global settings view scope', async () => {
    expect((await app().request('/profile')).status).toBe(403);
    mocks.scopes = ['pages:settings:view'];
    expect((await app().request('/profile')).status).toBe(200);
    expect(mocks.service.get).toHaveBeenCalledOnce();
  });

  it('serves safe selection options through the Pages settings scope', async () => {
    expect((await app().request('/options')).status).toBe(403);
    mocks.scopes = ['pages:settings:view'];
    expect((await app().request('/options')).status).toBe(200);
    expect(mocks.service.getOptions).toHaveBeenCalledOnce();
  });

  it('requires the global settings edit scope and forwards the actor', async () => {
    const init = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        domainId: UUID,
        nodeId: UUID,
        certificateId: UUID,
        labelTemplate: 'preview-{hash}',
      }),
    };
    expect((await app().request('/profile', init)).status).toBe(403);

    mocks.scopes = ['pages:settings:edit'];
    expect((await app().request('/profile', init)).status).toBe(200);
    expect(mocks.service.configure).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, labelTemplate: 'preview-{hash}' }),
      'user-1'
    );
  });

  it('allows reading settings but requires the Pages entitlement to save them', async () => {
    mocks.scopes = ['pages:settings:view', 'pages:settings:edit'];
    mocks.licensePolicy.requireFeature.mockRejectedValueOnce(
      new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'Personal plan required')
    );

    expect((await app().request('/profile')).status).toBe(200);
    const response = await app().request('/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(403);
    expect(mocks.service.configure).not.toHaveBeenCalled();
  });
});
