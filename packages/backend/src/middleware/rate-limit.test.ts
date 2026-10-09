import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { RATE_LIMIT_REDIS_TIMEOUT_MS } from '@/lib/rate-limit-timeout.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { createApiRateLimitMiddleware, createRateLimiter } from './rate-limit.js';

interface Entry {
  score: number;
  member: string;
}

class MemoryRedis {
  readonly sets = new Map<string, Entry[]>();
  readonly zaddMembers: string[] = [];

  pipeline() {
    return new MemoryPipeline(this);
  }
}

class MemoryPipeline {
  private readonly ops: Array<() => number> = [];

  constructor(private readonly redis: MemoryRedis) {}

  zremrangebyscore(key: string, min: number, max: number) {
    this.ops.push(() => {
      const entries = this.redis.sets.get(key) ?? [];
      const remaining = entries.filter((entry) => entry.score < min || entry.score > max);
      this.redis.sets.set(key, remaining);
      return entries.length - remaining.length;
    });
    return this;
  }

  zcard(key: string) {
    this.ops.push(() => this.redis.sets.get(key)?.length ?? 0);
    return this;
  }

  zadd(key: string, score: number, member: string) {
    this.ops.push(() => {
      this.redis.zaddMembers.push(member);
      const entries = this.redis.sets.get(key) ?? [];
      entries.push({ score, member });
      this.redis.sets.set(key, entries);
      return 1;
    });
    return this;
  }

  expire() {
    this.ops.push(() => 1);
    return this;
  }

  async exec() {
    return this.ops.map((op) => [null, op()] as [null, number]);
  }
}

class NullExecRedis {
  pipeline() {
    return {
      zremrangebyscore: () => this.pipeline(),
      zcard: () => this.pipeline(),
      zadd: () => this.pipeline(),
      expire: () => this.pipeline(),
      exec: async () => null,
    };
  }
}

class ThrowingExecRedis {
  pipeline() {
    return {
      zremrangebyscore: () => this.pipeline(),
      zcard: () => this.pipeline(),
      zadd: () => this.pipeline(),
      expire: () => this.pipeline(),
      exec: async () => {
        throw new Error('redis down');
      },
    };
  }
}

class ErrorTupleRedis {
  pipeline() {
    return {
      zremrangebyscore: () => this.pipeline(),
      zcard: () => this.pipeline(),
      zadd: () => this.pipeline(),
      expire: () => this.pipeline(),
      exec: async () => [[new Error('redis command failed'), null]],
    };
  }
}

class MalformedCountRedis {
  pipeline() {
    return {
      zremrangebyscore: () => this.pipeline(),
      zcard: () => this.pipeline(),
      zadd: () => this.pipeline(),
      expire: () => this.pipeline(),
      exec: async () => [
        [null, 0],
        [null, 'not-a-number'],
        [null, 1],
        [null, 1],
      ],
    };
  }
}

class TruncatedResultsRedis {
  pipeline() {
    return {
      zremrangebyscore: () => this.pipeline(),
      zcard: () => this.pipeline(),
      zadd: () => this.pipeline(),
      expire: () => this.pipeline(),
      exec: async () => [
        [null, 0],
        [null, 0],
      ],
    };
  }
}

class HangingExecRedis {
  pipeline() {
    return {
      zremrangebyscore: () => this.pipeline(),
      zcard: () => this.pipeline(),
      zadd: () => this.pipeline(),
      expire: () => this.pipeline(),
      exec: async () => new Promise<never>(() => {}),
    };
  }
}

function registerRedis<T>(redis: T): T {
  container.registerInstance(TOKENS.RedisClient, redis as any);
  return redis;
}

function registerMemoryRedis(): MemoryRedis {
  return registerRedis(new MemoryRedis());
}

function createTestApp() {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json({ code: error.code, message: error.message }, error.statusCode as 400);
    }
    throw error;
  });
  return app;
}

afterEach(() => {
  container.reset();
});

describe('createRateLimiter', () => {
  it('rejects requests after the configured sliding-window limit', async () => {
    registerMemoryRedis();
    const app = createTestApp();
    app.use('*', createRateLimiter({ windowMs: 60_000, maxRequests: 2, keyPrefix: 'test:limit' }));
    app.get('/', (c) => c.text('ok'));

    expect((await app.request('/', { headers: { 'x-real-ip': '192.0.2.10' } })).status).toBe(200);
    const second = await app.request('/', { headers: { 'x-real-ip': '192.0.2.10' } });
    expect(second.status).toBe(200);
    expect(second.headers.get('X-RateLimit-Remaining')).toBe('0');

    const limited = await app.request('/', { headers: { 'x-real-ip': '192.0.2.10' } });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  });

  it('keeps global and route-specific buckets independent', async () => {
    registerMemoryRedis();
    const app = createTestApp();
    app.use('/api/*', createRateLimiter({ windowMs: 60_000, maxRequests: 10, keyPrefix: 'test:global' }));
    app.use('/api/auth/*', createRateLimiter({ windowMs: 60_000, maxRequests: 1, keyPrefix: 'test:auth' }));
    app.get('/api/auth/login', (c) => c.text('auth'));
    app.get('/api/other', (c) => c.text('other'));

    const firstAuth = await app.request('/api/auth/login', { headers: { 'x-real-ip': '192.0.2.20' } });
    expect(firstAuth.status).toBe(200);
    expect(firstAuth.headers.get('X-RateLimit-Limit')).toBe('1');

    expect((await app.request('/api/auth/login', { headers: { 'x-real-ip': '192.0.2.20' } })).status).toBe(429);
    expect((await app.request('/api/other', { headers: { 'x-real-ip': '192.0.2.20' } })).status).toBe(200);
  });

  it('uses crypto-random UUID members for Redis sorted-set entries', async () => {
    const redis = registerMemoryRedis();
    const app = createTestApp();
    app.use('*', createRateLimiter({ windowMs: 60_000, maxRequests: 2, keyPrefix: 'test:limit' }));
    app.get('/', (c) => c.text('ok'));

    await app.request('/', { headers: { 'x-real-ip': '192.0.2.30' } });

    expect(redis.zaddMembers).toHaveLength(1);
    expect(redis.zaddMembers[0]).toMatch(
      /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('fails closed when Redis pipeline returns null', async () => {
    registerRedis(new NullExecRedis());
    const app = createTestApp();
    app.use('*', createRateLimiter({ windowMs: 60_000, maxRequests: 2, keyPrefix: 'test:null' }));
    app.get('/', (c) => c.text('ok'));

    const response = await app.request('/', { headers: { 'x-real-ip': '192.0.2.40' } });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
  });

  it('fails closed when Redis is not registered', async () => {
    const app = createTestApp();
    app.use('*', createRateLimiter({ windowMs: 60_000, maxRequests: 2, keyPrefix: 'test:missing' }));
    app.get('/', (c) => c.text('ok'));

    const response = await app.request('/', { headers: { 'x-real-ip': '192.0.2.45' } });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
  });

  it('fails closed when Redis pipeline execution throws', async () => {
    registerRedis(new ThrowingExecRedis());
    const app = createTestApp();
    app.use('*', createRateLimiter({ windowMs: 60_000, maxRequests: 2, keyPrefix: 'test:throw' }));
    app.get('/', (c) => c.text('ok'));

    const response = await app.request('/', { headers: { 'x-real-ip': '192.0.2.50' } });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
  });

  it('fails closed when Redis pipeline includes a command error', async () => {
    registerRedis(new ErrorTupleRedis());
    const app = createTestApp();
    app.use('*', createRateLimiter({ windowMs: 60_000, maxRequests: 2, keyPrefix: 'test:tuple' }));
    app.get('/', (c) => c.text('ok'));

    const response = await app.request('/', { headers: { 'x-real-ip': '192.0.2.60' } });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
  });

  it('fails closed when Redis pipeline returns a malformed count', async () => {
    registerRedis(new MalformedCountRedis());
    const app = createTestApp();
    app.use('*', createRateLimiter({ windowMs: 60_000, maxRequests: 2, keyPrefix: 'test:malformed' }));
    app.get('/', (c) => c.text('ok'));

    const response = await app.request('/', { headers: { 'x-real-ip': '192.0.2.70' } });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
  });

  it('fails closed when Redis pipeline returns incomplete results', async () => {
    registerRedis(new TruncatedResultsRedis());
    const app = createTestApp();
    app.use('*', createRateLimiter({ windowMs: 60_000, maxRequests: 2, keyPrefix: 'test:truncated' }));
    app.get('/', (c) => c.text('ok'));

    const response = await app.request('/', { headers: { 'x-real-ip': '192.0.2.80' } });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
  });

  it('fails closed when Redis pipeline execution stalls', async () => {
    vi.useFakeTimers();
    try {
      registerRedis(new HangingExecRedis());
      const app = createTestApp();
      app.use('*', createRateLimiter({ windowMs: 60_000, maxRequests: 2, keyPrefix: 'test:timeout' }));
      app.get('/', (c) => c.text('ok'));

      const responsePromise = app.request('/', { headers: { 'x-real-ip': '192.0.2.90' } });
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_REDIS_TIMEOUT_MS);
      const response = await responsePromise;

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createApiRateLimitMiddleware', () => {
  it('gives each signed-in session a budget of its own and counts everything else per client IP', async () => {
    const redis = registerMemoryRedis();
    const app = createTestApp();
    // Defaults: 1200 per IP, 6000 per session in a minute.
    app.use(
      '*',
      createApiRateLimitMiddleware(async (c) => c.req.header('x-test-session') ?? null)
    );
    app.get('/', (c) => c.text('ok'));
    const ip = { 'x-real-ip': '192.0.2.90' };

    for (let index = 0; index < 1_200; index++) await app.request('/', { headers: ip });
    expect((await app.request('/', { headers: ip })).status).toBe(429);

    // The UI behind the same IP is not limited by the scripts' traffic.
    const session = await app.request('/', { headers: { ...ip, 'x-test-session': 'session-secret' } });
    expect(session.status).toBe(200);
    expect(session.headers.get('X-RateLimit-Limit')).toBe('6000');
    // The counter is named by a hash of the session, never by the session ID.
    expect([...redis.sets.keys()].some((key) => key.includes('session-secret'))).toBe(false);
    expect([...redis.sets.keys()].some((key) => key.startsWith('ratelimit:api:session:'))).toBe(true);
  });
});
