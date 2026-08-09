import 'reflect-metadata';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { StatusPageService } from '@/modules/status-page/status-page.service.js';
import { GatewayLifecycleService } from '@/services/gateway-lifecycle.service.js';
import { createApp } from './app.js';
import { container, TOKENS } from './container.js';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'http://gateway.test';
  process.env.DATABASE_URL ||= 'http://localhost/db';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.PKI_MASTER_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
});

afterEach(() => container.reset());

describe('Gateway lifecycle admission middleware', () => {
  it('rejects new user requests while keeping health available', async () => {
    const lifecycle = new GatewayLifecycleService();
    lifecycle.transition('draining_user');
    container.registerInstance(GatewayLifecycleService, lifecycle);
    container.registerInstance(StatusPageService, { isStatusHost: vi.fn().mockResolvedValue(false) } as never);
    container.registerInstance(TOKENS.RedisClient, { ping: vi.fn().mockResolvedValue('PONG') } as never);
    const app = createApp().app;

    const rejected = await app.request('/api/users', { headers: { host: 'gateway.test' } });
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('retry-after')).toBe('1');
    expect(await rejected.json()).toEqual({ code: 'SERVICE_RESTARTING', message: 'Gateway is restarting' });

    const health = await app.request('/health', { headers: { host: 'gateway.test' } });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ lifecycleState: 'draining_user' });
  });

  it('keeps the configured public status host admitted during log drain', async () => {
    const lifecycle = new GatewayLifecycleService();
    lifecycle.transition('draining_logs');
    container.registerInstance(GatewayLifecycleService, lifecycle);
    container.registerInstance(StatusPageService, { isStatusHost: vi.fn().mockResolvedValue(true) } as never);

    const response = await createApp().app.request('/missing', { headers: { host: 'status.example.com' } });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('SERVICE_RESTARTING');
  });
});
