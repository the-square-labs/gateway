import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import type { LicenseStatusView } from './license.types.js';
import { LicensePolicyService } from './license-policy.service.js';

const baseStatus = (): LicenseStatusView => ({
  status: 'community',
  plan: 'community',
  registrationStatus: 'registered',
  paidLicenseStatus: 'none',
  licensed: true,
  hasKey: false,
  keyLast4: null,
  licenseName: null,
  licenseMetadata: {},
  installationId: 'installation-id',
  installationName: 'gateway.example.com',
  expiresAt: null,
  entitlementsVersion: 2,
  entitlements: {
    managedNodes: 100,
    users: 10,
    customPermissionGroups: 5,
    supportLevel: 'community',
    features: ['infrastructure'],
  },
  lastCheckedAt: null,
  lastValidAt: null,
  graceUntil: null,
  offlineGraceUntil: null,
  activeInstallationId: null,
  activeInstallationName: null,
  errorMessage: null,
  serverUrl: 'https://license.wiolett.cloud',
});

describe('LicensePolicyService', () => {
  it('returns the structured entitlement error for a missing feature', async () => {
    const policy = new LicensePolicyService({ getStatus: vi.fn(async () => baseStatus()) } as never);

    await expect(policy.requireFeature('secure-runtime')).rejects.toMatchObject({
      statusCode: 403,
      code: 'LICENSE_ENTITLEMENT_REQUIRED',
      details: {
        feature: 'secure-runtime',
        requiredPlan: 'business',
        currentPlan: 'community',
        licenseStatus: 'community',
      },
    });
  });

  it('allows a feature present in the effective entitlement set', async () => {
    const status = baseStatus();
    status.plan = 'business';
    status.status = 'expired_grace';
    status.entitlements.features.push('secure-runtime');
    const policy = new LicensePolicyService({ getStatus: vi.fn(async () => status) } as never);

    await expect(policy.requireFeature('secure-runtime')).resolves.toBeUndefined();
  });

  it('returns the structured quota error at the effective limit', async () => {
    const policy = new LicensePolicyService({ getStatus: vi.fn(async () => baseStatus()) } as never);

    await expect(policy.requireQuota('users', 10)).rejects.toMatchObject({
      statusCode: 409,
      code: 'LICENSE_QUOTA_EXCEEDED',
      details: { resource: 'users', limit: 10, current: 10, currentPlan: 'community' },
    });
  });

  it('fails protected mutations closed with a generic error for an unsupported policy version', async () => {
    const status = baseStatus();
    status.entitlementsVersion = 999;
    const policy = new LicensePolicyService({ getStatus: vi.fn(async () => status) } as never);

    const error = await policy.requireFeature('managed-databases').catch((reason) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'The requested operation is temporarily unavailable',
    });
    expect(error.details).toBeUndefined();
  });

  it('projects only safe license fields for UI bootstrap', async () => {
    const status = baseStatus();
    status.licenseMetadata = { secret: 'not-for-ui' };
    status.keyLast4 = 'DDDD';
    const policy = new LicensePolicyService({ getStatus: vi.fn(async () => status) } as never);

    const summary = await policy.getSummary();

    expect(summary).not.toHaveProperty('licenseMetadata');
    expect(summary).not.toHaveProperty('keyLast4');
    expect(summary).not.toHaveProperty('installationId');
    expect(summary).toMatchObject({ plan: 'community', entitlementsVersion: 2 });
  });
});
