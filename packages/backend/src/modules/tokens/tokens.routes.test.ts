import 'reflect-metadata';
import '@/db/schema/index.js';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { DockerInternalRegistryService } from '@/modules/docker/docker-registry-internal.service.js';
import type { AppEnv } from '@/types.js';

const session = vi.hoisted(() => ({ authType: 'session', scopes: ['docker:containers:view'] }));

vi.mock('@/modules/auth/auth.middleware.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/auth/auth.middleware.js')>()),
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1', scopes: session.scopes });
    c.set('authType', session.authType);
    await next();
  },
}));

const { tokensRoutes } = await import('./tokens.routes.js');
const { TokensService } = await import('./tokens.service.js');

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
  session.scopes = ['docker:containers:view'];
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

describe('token create route', () => {
  const USE_LINE = [
    'integrations:github:use:0b8f2a8e-6f1c-4a57-9a51-3f9d7f1b2c01/repo/7',
    'integrations:github:view:0b8f2a8e-6f1c-4a57-9a51-3f9d7f1b2c01/repo/7',
  ];

  async function create(body: Record<string, unknown>) {
    session.scopes = ['integrations:github:view', 'integrations:github:use', 'integrations:github:repo:read'];
    const createToken = vi.fn().mockResolvedValue({ id: 'token-1' });
    container.registerInstance(TokensService, { createToken } as unknown as InstanceType<typeof TokensService>);
    const app = new OpenAPIHono<AppEnv>();
    app.onError(errorHandler);
    app.route('/api/tokens', tokensRoutes);
    const response = await app.request('/api/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ci', ...body }),
    });
    expect(response.status).toBe(201);
    return createToken.mock.calls[0]![1].scopes as string[];
  }

  it('stores exactly the requested scopes when asked to', async () => {
    expect(await create({ scopes: USE_LINE, exactScopes: true })).toEqual(USE_LINE);
  });

  it('keeps the grants older scripts expect without the flag', async () => {
    expect(await create({ scopes: USE_LINE })).toEqual([
      'integrations:github:repo:read:0b8f2a8e-6f1c-4a57-9a51-3f9d7f1b2c01/repo/7',
      ...USE_LINE,
    ]);
  });
});
