import 'reflect-metadata';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { container, TOKENS } from './container.js';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ||= 'http://localhost/db';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.OIDC_ISSUER ||= 'http://localhost/oidc';
  process.env.OIDC_CLIENT_ID ||= 'test';
  process.env.OIDC_CLIENT_SECRET ||= 'test';
  process.env.OIDC_REDIRECT_URI ||= 'http://localhost/auth/callback';
  process.env.APP_URL = 'http://gateway.test';
  process.env.PKI_MASTER_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
});

afterEach(() => {
  container.reset();
});

describe('/health', () => {
  it('returns healthy when Redis answers PONG', async () => {
    container.registerInstance(TOKENS.RedisClient, {
      ping: vi.fn().mockResolvedValue('PONG'),
    } as any);

    const response = await createApp().app.request('/health', { headers: { host: 'gateway.test' } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      lifecycleState: 'running',
      version: 'dev',
      dependencies: { redis: 'ok' },
    });
  });

  it('returns unavailable when Redis ping fails', async () => {
    container.registerInstance(TOKENS.RedisClient, {
      ping: vi.fn().mockRejectedValue(new Error('redis down')),
    } as any);

    const response = await createApp().app.request('/health', { headers: { host: 'gateway.test' } });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'unavailable',
      dependencies: { redis: 'unavailable' },
    });
  });

  it('returns unavailable when Redis is not registered', async () => {
    const response = await createApp().app.request('/health', { headers: { host: 'gateway.test' } });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'unavailable',
      dependencies: { redis: 'unavailable' },
    });
  });
});
