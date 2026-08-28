import { createChildLogger } from '@/lib/logger.js';
import { withRateLimitRedisTimeout } from '@/lib/rate-limit-timeout.js';
import { AppError } from '@/middleware/error-handler.js';
import type { EnvironmentSettings } from '@/modules/settings/environment-settings.schemas.js';
import { getEnvironmentSettingsSnapshot } from '@/modules/settings/environment-settings.service.js';
import type { RedisClient } from '@/services/cache.service.js';

type RateScope = 'global' | 'token' | 'environment';

const logger = createChildLogger('LoggingRateLimit');

function rateLimitUnavailable(error?: unknown): AppError {
  logger.warn('Logging rate limiter unavailable', {
    error: error instanceof Error ? error.message : error == null ? undefined : String(error),
  });
  return new AppError(503, 'RATE_LIMIT_UNAVAILABLE', 'Gateway is temporarily unavailable');
}

export class LoggingRateLimitService {
  constructor(
    private readonly redis: RedisClient,
    private readonly getLimits: () => EnvironmentSettings['loggingIngest'] = () =>
      getEnvironmentSettingsSnapshot().loggingIngest
  ) {}

  async check(params: {
    tokenId: string;
    environmentId: string;
    events: number;
    environmentRequestLimit: number | null;
    environmentEventLimit: number | null;
  }): Promise<void> {
    const limits = this.getLimits();
    const windowSeconds = limits.rateLimitWindowSeconds;
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    await this.hit(`logging:rl:${bucket}:global:requests`, 1, limits.globalRequestsPerWindow, windowSeconds, 'global');
    await this.hit(
      `logging:rl:${bucket}:global:events`,
      params.events,
      limits.globalEventsPerWindow,
      windowSeconds,
      'global'
    );
    await this.hit(
      `logging:rl:${bucket}:token:${params.tokenId}:requests`,
      1,
      limits.tokenRequestsPerWindow,
      windowSeconds,
      'token'
    );
    await this.hit(
      `logging:rl:${bucket}:token:${params.tokenId}:events`,
      params.events,
      limits.tokenEventsPerWindow,
      windowSeconds,
      'token'
    );
    await this.hit(
      `logging:rl:${bucket}:env:${params.environmentId}:requests`,
      1,
      params.environmentRequestLimit ?? limits.tokenRequestsPerWindow,
      windowSeconds,
      'environment'
    );
    await this.hit(
      `logging:rl:${bucket}:env:${params.environmentId}:events`,
      params.events,
      params.environmentEventLimit ?? limits.tokenEventsPerWindow,
      windowSeconds,
      'environment'
    );
  }

  private async hit(
    key: string,
    amount: number,
    limit: number,
    windowSeconds: number,
    scope: RateScope
  ): Promise<void> {
    let count: number;
    try {
      count = await withRateLimitRedisTimeout(this.redis.incrby(key, amount));
      if (typeof count !== 'number' || !Number.isFinite(count)) {
        throw new Error('Redis returned invalid logging rate-limit count');
      }
      if (count === amount) {
        const expireResult = await withRateLimitRedisTimeout(this.redis.expire(key, windowSeconds));
        if (expireResult !== 1) {
          throw new Error('Redis failed to set logging rate-limit expiry');
        }
      }
    } catch (error) {
      throw rateLimitUnavailable(error);
    }

    if (count > limit) {
      let ttl: number;
      try {
        ttl = await withRateLimitRedisTimeout(this.redis.ttl(key));
        if (typeof ttl !== 'number' || !Number.isFinite(ttl)) {
          throw new Error('Redis returned invalid logging rate-limit TTL');
        }
      } catch (error) {
        throw rateLimitUnavailable(error);
      }
      throw new AppError(429, 'LOGGING_RATE_LIMIT_EXCEEDED', 'Logging ingest rate limit exceeded', {
        scope,
        retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
      });
    }
  }
}
