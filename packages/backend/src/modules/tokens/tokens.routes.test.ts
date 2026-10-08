import 'reflect-metadata';
import '@/db/schema/index.js';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { DockerInternalRegistryService } from '@/modules/docker/docker-registry-internal.service.js';
import type { AppEnv } from '@/types.js';

const session = vi.hoisted(() => ({ authType: 'session' }));

vi.mock('@/modules/auth/auth.middleware.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/auth/auth.middleware.js')>()),
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1', scopes: ['docker:containers:view'] });
    c.set('authType', session.authType);
    await next();
  },
}));

const { tokensRoutes } = await import('./tokens.routes.js');

function setup(externalAccessEnabled: boolean) {
  container.registerInstance(DockerInternalRegistryService, {
    getState: vi.fn().mockResolvedValue({ externalAccessEnabled }),
  } as unknown as DockerInternalRegistryService);
  const app = new OpenAPIHono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/tokens', tokensRoutes);
  return () => app.request('/api/tokens/registry-access');
}

afterEach(() => {
  container.reset();
  session.authType = 'session';
});

describe('token registry access route', () => {
  it('says whether Docker clients can reach the internal registry', async () => {
    for (const enabled of [true, false]) {
      const response = await setup(enabled)();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ externalAccessEnabled: enabled });
      container.reset();
    }
  });

  it('answers browser sessions only, like the other token routes', async () => {
    session.authType = 'token';
    expect((await setup(true)()).status).toBe(403);
  });
});
