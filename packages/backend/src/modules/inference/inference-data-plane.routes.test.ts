import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { AppEnv } from '@/types.js';
import { InferenceCoreProxyService } from './core/inference-core-proxy.service.js';
import { inferenceDataPlaneRoutes } from './inference-data-plane.routes.js';
import { InferenceTokenService } from './inference-token.service.js';
import { InferenceModelService } from './models/inference-model.service.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'http://localhost/db';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.PKI_MASTER_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

function registerRedis() {
  const pipeline = {
    zremrangebyscore: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([
      [null, 0],
      [null, 0],
      [null, 1],
      [null, 1],
    ]),
  };
  container.registerInstance(TOKENS.RedisClient, {
    pipeline: vi.fn().mockReturnValue(pipeline),
    eval: vi.fn().mockResolvedValue(1),
  } as never);
}

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'user@example.com',
  name: 'User',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'inference-users',
  scopes: ['feat:ai:use'],
  isBlocked: false,
} as const;

function createApp() {
  registerRedis();
  const app = new Hono<AppEnv>();
  app.route('/api/inference/v1', inferenceDataPlaneRoutes);
  return app;
}

function registerAuth(valid = true) {
  container.registerInstance(InferenceTokenService, {
    validateToken: vi.fn().mockResolvedValue(valid ? { user: USER, tokenId: 'token-1', tokenPrefix: 'gwi_a' } : null),
  } as unknown as InferenceTokenService);
}

function registerProxy() {
  const proxy = { proxy: vi.fn().mockImplementation(() => Promise.resolve(new Response('ok', { status: 200 }))) };
  container.registerInstance(InferenceCoreProxyService, proxy as unknown as InferenceCoreProxyService);
  return proxy;
}

afterEach(() => container.reset());

describe('inference data plane routes', () => {
  it('rejects requests without a gateway inference token', async () => {
    registerAuth(false);
    registerProxy();
    const response = await createApp().request('/api/inference/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer gwi_bad.token' },
      body: JSON.stringify({ model: 'm', input: 'hi' }),
    });
    expect(response.status).toBe(401);
  });

  it('serves the gateway-owned model catalog', async () => {
    registerAuth();
    registerProxy();
    container.registerInstance(InferenceModelService, {
      listForUser: vi.fn().mockResolvedValue({ object: 'list', data: [{ id: 'gpt-5.5', object: 'model' }] }),
    } as unknown as InferenceModelService);
    const response = await createApp().request('/api/inference/v1/models', {
      headers: { authorization: 'Bearer gwi_a.token' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ object: 'list', data: [{ id: 'gpt-5.5', object: 'model' }] });
  });

  it('dispatches the standard route set to the core proxy', async () => {
    registerAuth();
    const proxy = registerProxy();
    const app = createApp();
    for (const [path, operation] of [
      ['/responses', 'responses'],
      ['/responses/compact', 'responses/compact'],
      ['/chat/completions', 'chat/completions'],
      ['/messages', 'messages'],
      ['/messages/count_tokens', 'messages/count_tokens'],
      ['/images/generations', 'images/generations'],
      ['/images/edits', 'images/edits'],
      ['/alpha/search', 'alpha/search'],
      ['/live', 'live'],
      ['/realtime/calls', 'realtime/calls'],
    ] as const) {
      const response = await app.request(`/api/inference/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer gwi_a.token' },
        body: JSON.stringify({ model: 'm' }),
      });
      expect(response.status, path).toBe(200);
      expect(proxy.proxy).toHaveBeenCalledWith(expect.anything(), operation);
    }
  });

  it('answers 404 for unknown inference endpoints', async () => {
    registerAuth();
    registerProxy();
    const response = await createApp().request('/api/inference/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer gwi_a.token' },
      body: '{}',
    });
    expect(response.status).toBe(404);
  });
});
