import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { getEnv } from '@/config/env.js';
import { container, TOKENS } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { withRateLimitRedisTimeout } from '@/lib/rate-limit-timeout.js';
import type { RedisClient } from '@/services/cache.service.js';
import type { AppEnv } from '@/types.js';
import { inferenceErrorResponse } from './inference-error.js';
import { InferenceProtocolError } from './protocol/inference-protocol.error.js';

const logger = createChildLogger('InferenceLimit');

const ACQUIRE_CONCURRENCY_SCRIPT = `
local now = tonumber(ARGV[1])
local expiry = tonumber(ARGV[2])
local lease = ARGV[3]
local limit = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= limit then return 0 end
redis.call('ZADD', KEYS[1], expiry, lease)
redis.call('PEXPIRE', KEYS[1], expiry - now + 60000)
return 1
`;

const RENEW_CONCURRENCY_SCRIPT = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) == false then return 0 end
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
`;

const RELEASE_CONCURRENCY_SCRIPT = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

interface InferenceLimitAuth {
  tokenId: string;
}

export async function consumeInferenceRateLimit(
  auth: InferenceLimitAuth
): Promise<{ limit: number; remaining: number }> {
  const env = getEnv();
  const redis = container.resolve<RedisClient>(TOKENS.RedisClient);
  const now = Date.now();
  const windowStart = now - env.RATE_LIMIT_WINDOW_MS;
  const key = `ratelimit:inference:${auth.tokenId}`;
  try {
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zcard(key);
    pipeline.zadd(key, now, `${now}-${randomUUID()}`);
    pipeline.expire(key, Math.ceil(env.RATE_LIMIT_WINDOW_MS / 1000));
    const results = await withRateLimitRedisTimeout(pipeline.exec());
    const count = Array.isArray(results) && Array.isArray(results[1]) ? results[1][1] : null;
    if (typeof count !== 'number') throw new Error('Invalid Redis rate limit response');
    if (count >= env.RATE_LIMIT_INFERENCE_MAX_REQUESTS) {
      throw new InferenceProtocolError(429, 'rate_limit_exceeded', 'Inference request rate limit exceeded');
    }
    return {
      limit: env.RATE_LIMIT_INFERENCE_MAX_REQUESTS,
      remaining: Math.max(0, env.RATE_LIMIT_INFERENCE_MAX_REQUESTS - count - 1),
    };
  } catch (error) {
    if (error instanceof InferenceProtocolError) throw error;
    logger.warn('Inference rate limiter unavailable', { error });
    throw new InferenceProtocolError(503, 'service_unavailable', 'Inference admission is temporarily unavailable');
  }
}

export async function acquireInferenceConcurrency(auth: InferenceLimitAuth): Promise<() => Promise<void>> {
  const redis = container.resolve<RedisClient>(TOKENS.RedisClient);
  const env = getEnv();
  const key = `concurrency:inference:${auth.tokenId}`;
  const leaseId = randomUUID();
  const leaseMs = env.INFERENCE_CONCURRENCY_LEASE_SECONDS * 1000;
  try {
    const acquired = await redis.eval(
      ACQUIRE_CONCURRENCY_SCRIPT,
      1,
      key,
      Date.now(),
      Date.now() + leaseMs,
      leaseId,
      env.INFERENCE_MAX_CONCURRENT_REQUESTS_PER_TOKEN
    );
    if (Number(acquired) !== 1) {
      throw new InferenceProtocolError(429, 'rate_limit_exceeded', 'Too many concurrent inference requests');
    }
    let released = false;
    const renewal = setInterval(
      () => {
        const now = Date.now();
        void redis
          .eval(RENEW_CONCURRENCY_SCRIPT, 1, key, leaseId, now + leaseMs, leaseMs + 60_000)
          .then((renewed) => {
            if (Number(renewed) !== 1) clearInterval(renewal);
          })
          .catch((error) => logger.warn('Failed to renew inference concurrency lease', { error }));
      },
      Math.max(1000, Math.floor(leaseMs / 3))
    );
    renewal.unref();
    return async () => {
      if (released) return;
      released = true;
      clearInterval(renewal);
      try {
        await redis.eval(RELEASE_CONCURRENCY_SCRIPT, 1, key, leaseId);
      } catch (error) {
        logger.warn('Failed to release inference concurrency lease', { error });
      }
    };
  } catch (error) {
    if (error instanceof InferenceProtocolError) throw error;
    logger.warn('Inference concurrency limiter unavailable', { error });
    throw new InferenceProtocolError(503, 'service_unavailable', 'Inference admission is temporarily unavailable');
  }
}

export const inferenceRateLimitMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === 'OPTIONS') return next();
  const auth = c.get('inferenceAuth');
  if (!auth) return inferenceErrorResponse(c, 401, 'invalid_api_key', 'Authentication required');

  try {
    const result = await consumeInferenceRateLimit(auth);
    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
  } catch (error) {
    const protocol = error as InferenceProtocolError;
    return inferenceErrorResponse(c, protocol.status, protocol.code, protocol.message);
  }

  await next();
};

export const inferenceConcurrencyMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === 'OPTIONS') return next();
  const auth = c.get('inferenceAuth');
  if (!auth) return inferenceErrorResponse(c, 401, 'invalid_api_key', 'Authentication required');

  let release: (() => Promise<void>) | null = null;
  let releaseOwnedByBody = false;

  try {
    release = await acquireInferenceConcurrency(auth);
  } catch (error) {
    const protocol = error as InferenceProtocolError;
    return inferenceErrorResponse(c, protocol.status, protocol.code, protocol.message);
  }

  try {
    await next();
    const response = c.res;
    if (response.body) {
      const reader = response.body.getReader();
      const releaseBody = release;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              await releaseBody();
              controller.close();
              return;
            }
            controller.enqueue(chunk.value);
          } catch (error) {
            await releaseBody();
            controller.error(error);
          }
        },
        async cancel(reason) {
          await reader.cancel(reason).catch(() => undefined);
          await releaseBody();
        },
      });
      c.res = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      releaseOwnedByBody = true;
    }
  } finally {
    if (release && !releaseOwnedByBody) await release();
  }
};
