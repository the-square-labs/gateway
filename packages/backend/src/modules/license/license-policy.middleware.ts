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

export function requireLicenseFeatureForExistingRuntime(feature: LicenseFeature): MiddlewareHandler<AppEnv> {
  return async (_c, next) => {
    await container.resolve(LicensePolicyService).requireFeatureForExistingRuntime(feature);
    await next();
  };
}

/** Whether a request only reads, deletes, or operates existing paid resources. */
export function isExistingResourceRequest(method: string, path: string, existingActions: readonly RegExp[]): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') return true;
  return method === 'POST' && existingActions.some((pattern) => pattern.test(path));
}

/**
 * Reads and deletes of existing paid resources keep working after the license grace
 * period; every other method creates or changes them and needs the current plan.
 * `existingActions` lists POST paths that only read or operate existing resources.
 */
export function requireLicenseFeatureForRequest(
  feature: LicenseFeature,
  existingActions: readonly RegExp[] = []
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const policy = container.resolve(LicensePolicyService);
    // LICENSE ENFORCEMENT: Only reads, deletes, and listed operations on existing resources use continuity.
    if (isExistingResourceRequest(c.req.method, c.req.path, existingActions)) {
      await policy.requireFeatureForExistingRuntime(feature);
    } else {
      await policy.requireFeature(feature);
    }
    await next();
  };
}
