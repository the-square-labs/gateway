import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { EnvironmentSettings } from '@/modules/settings/environment-settings.schemas.js';
import type { RedisClient } from '@/services/cache.service.js';
export class LoggingRateLimitService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_redis: RedisClient, _getLimits?: () => EnvironmentSettings['loggingIngest']) {}
  async check(_params: {
    tokenId: string;
    environmentId: string;
    events: number;
    environmentRequestLimit: number | null;
    environmentEventLimit: number | null;
  }): Promise<void> {
    return commercialModuleUnavailable();
  }
}
