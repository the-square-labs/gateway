import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { requireLicenseFeature, requireLicenseFeatureForExistingRuntime } from './license-policy.middleware.js';
import { LicensePolicyService } from './license-policy.service.js';

afterEach(() => container.reset());

describe('requireLicenseFeature', () => {
  it('returns the canonical entitlement error before a protected route runs', async () => {
    const handler = vi.fn((c: { json: (value: unknown) => Response }) => c.json({ ok: true }));
    container.registerInstance(LicensePolicyService, {
      requireFeature: vi.fn().mockRejectedValue(
        new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'A higher license plan is required', {
          feature: 'internal-pki',
          requiredPlan: 'enterprise',
        })
      ),
    } as unknown as LicensePolicyService);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.use('*', requireLicenseFeature('internal-pki'));
    app.get('/', handler as never);

    const response = await app.request('/');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'LICENSE_ENTITLEMENT_REQUIRED' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('uses the continuity boundary only for routes serving existing configured runtime', async () => {
    const handler = vi.fn((c: { json: (value: unknown) => Response }) => c.json({ ok: true }));
    const requireFeatureForExistingRuntime = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(LicensePolicyService, {
      requireFeatureForExistingRuntime,
    } as unknown as LicensePolicyService);
    const app = new Hono<AppEnv>();
    app.use('*', requireLicenseFeatureForExistingRuntime('internal-pki'));
    app.get('/', handler as never);

    const response = await app.request('/');

    expect(response.status).toBe(200);
    expect(requireFeatureForExistingRuntime).toHaveBeenCalledWith('internal-pki');
    expect(handler).toHaveBeenCalledOnce();
  });
});
