import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authType: 'session' as 'session' | 'api-token',
  searchResources: vi.fn(),
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn(() => ({ searchResources: mocks.searchResources })),
  },
}));

vi.mock('@/modules/ai/ai.service.js', () => ({
  AIService: class AIService {},
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1', scopes: ['proxy:view'] });
    c.set('effectiveScopes', ['proxy:view']);
    c.set('authType', mocks.authType);
    await next();
  },
  sessionOnly: async (c: any, next: () => Promise<void>) => {
    if (c.get('authType') !== 'session') {
      return c.json({ message: 'This endpoint requires browser session authentication.' }, 403);
    }
    await next();
  },
}));

import { resourceSearchRoutes } from './resource-search.routes.js';

describe('resource search routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authType = 'session';
    mocks.searchResources.mockResolvedValue({
      query: 'api',
      results: [{ type: 'proxy_host', id: 'host-1', name: 'api.example.com', summary: {} }],
      total: 1,
      truncated: false,
    });
  });

  it('delegates browser searches with normalized query options', async () => {
    const response = await resourceSearchRoutes.request('/search?q=api&types=proxy_host%2Cnode&limit=12');

    expect(response.status).toBe(200);
    expect(mocks.searchResources).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1' }), {
      query: 'api',
      types: ['proxy_host', 'node'],
      nodeId: undefined,
      limit: 12,
    });
    await expect(response.json()).resolves.toEqual({
      data: expect.objectContaining({ query: 'api', total: 1 }),
    });
  });

  it('rejects API-token callers because the endpoint is UI-only', async () => {
    mocks.authType = 'api-token';
    const response = await resourceSearchRoutes.request('/search?q=api');

    expect(response.status).toBe(403);
    expect(mocks.searchResources).not.toHaveBeenCalled();
  });
});
