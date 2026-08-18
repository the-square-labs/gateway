import type { MiddlewareHandler } from 'hono';
import { container } from '@/container.js';
import type { AppEnv } from '@/types.js';
import { type LicenseFeature, LicensePolicyService } from './license-policy.service.js';

export function requireLicenseFeature(feature: LicenseFeature): MiddlewareHandler<AppEnv> {
  return async (_c, next) => {
    await container.resolve(LicensePolicyService).requireFeature(feature);
    await next();
  };
}
