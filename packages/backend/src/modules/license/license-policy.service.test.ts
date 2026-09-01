import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { LICENSE_PLAN_ENTITLEMENTS, LICENSE_PLAN_ENTITLEMENTS_V3, type LicenseStatusView } from './license.types.js';
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
  entitlementsVersion: 4,
  entitlements: LICENSE_PLAN_ENTITLEMENTS.community,
  lastCheckedAt: null,
  lastValidAt: null,
  graceUntil: null,
  offlineGraceUntil: null,
  activeInstallationId: null,
  activeInstallationName: null,
  errorMessage: null,
  serverUrl: 'https://license.thesqlabs.com',
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
    status.entitlements = LICENSE_PLAN_ENTITLEMENTS.business;
    const policy = new LicensePolicyService({ getStatus: vi.fn(async () => status) } as never);

    await expect(policy.requireFeature('secure-runtime')).resolves.toBeUndefined();
  });

  it.each([
    'expired',
    'unreachable_grace_expired',
  ] as const)('preserves existing configured runtime features after %s', async (licenseStatus) => {
    const status = baseStatus();
    status.status = licenseStatus;
    status.licensed = false;
    status.paidLicenseStatus = licenseStatus === 'expired' ? 'expired' : 'valid';
    const policy = new LicensePolicyService({
      getStatus: vi.fn(async () => status),
      getRuntimeContinuityEntitlements: vi.fn(async () => LICENSE_PLAN_ENTITLEMENTS.business),
    } as never);

    for (const feature of ['structured-logging', 'git-push-to-deploy', 'pages'] as const) {
      await expect(policy.hasFeatureForExistingRuntime(feature)).resolves.toBe(true);
      await expect(policy.requireFeatureForExistingRuntime(feature)).resolves.toBeUndefined();
      await expect(policy.hasFeature(feature)).resolves.toBe(false);
      await expect(policy.requireFeature(feature)).rejects.toMatchObject({
        statusCode: 403,
        code: 'LICENSE_ENTITLEMENT_REQUIRED',
      });
    }

    for (const feature of ['siem-export', 'internal-pki'] as const) {
      await expect(policy.hasFeatureForExistingRuntime(feature)).resolves.toBe(false);
      await expect(policy.requireFeatureForExistingRuntime(feature)).rejects.toMatchObject({
        statusCode: 403,
        code: 'LICENSE_ENTITLEMENT_REQUIRED',
      });
    }
  });

  it('does not invent retained paid entitlements for a Community-shaped expired status', async () => {
    const status = baseStatus();
    status.status = 'expired';
    status.paidLicenseStatus = 'expired';
    status.licensed = false;
    const policy = new LicensePolicyService({
      getStatus: vi.fn(async () => status),
      getRuntimeContinuityEntitlements: vi.fn(async () => null),
    } as never);

    await expect(policy.hasFeatureForExistingRuntime('pages')).resolves.toBe(false);
    await expect(policy.requireFeatureForExistingRuntime('pages')).rejects.toMatchObject({
      statusCode: 403,
      code: 'LICENSE_ENTITLEMENT_REQUIRED',
    });
  });

  it('uses current Community quotas after paid runtime continuity begins', async () => {
    const status = baseStatus();
    status.status = 'expired';
    status.paidLicenseStatus = 'expired';
    status.licensed = false;
    const policy = new LicensePolicyService({ getStatus: vi.fn(async () => status) } as never);

    await expect(policy.requireQuota('users', 10)).rejects.toMatchObject({
      statusCode: 409,
      code: 'LICENSE_QUOTA_EXCEEDED',
      details: { resource: 'users', limit: 10, currentPlan: 'community' },
    });
    await expect(policy.getSummary()).resolves.toMatchObject({
      plan: 'community',
      entitlements: LICENSE_PLAN_ENTITLEMENTS.community,
    });
  });

  it.each([
    'revoked',
    'replaced',
    'deactivated',
    'invalid',
  ] as const)('keeps existing configured runtime features fail-closed after %s', async (licenseStatus) => {
    const status = baseStatus();
    status.status = licenseStatus;
    status.licensed = false;
    const policy = new LicensePolicyService({ getStatus: vi.fn(async () => status) } as never);

    await expect(policy.hasFeatureForExistingRuntime('structured-logging')).resolves.toBe(false);
    await expect(policy.requireFeatureForExistingRuntime('structured-logging')).rejects.toMatchObject({
      statusCode: 403,
      code: 'LICENSE_ENTITLEMENT_REQUIRED',
    });
  });

  it('includes Pages in the canonical Personal entitlement set', async () => {
    const personal = baseStatus();
    personal.plan = 'personal';
    personal.status = 'valid';
    personal.entitlements = LICENSE_PLAN_ENTITLEMENTS.personal;
    const personalPolicy = new LicensePolicyService({ getStatus: vi.fn(async () => personal) } as never);
    await expect(personalPolicy.requireFeature('pages')).resolves.toBeUndefined();
    expect(LICENSE_PLAN_ENTITLEMENTS.community.features).not.toContain('pages');
    expect(LICENSE_PLAN_ENTITLEMENTS.personal.features).toContain('pages');
    expect(LICENSE_PLAN_ENTITLEMENTS.business.features).toContain('pages');
    expect(LICENSE_PLAN_ENTITLEMENTS.enterprise.features).toContain('pages');
  });

  it('includes Compose management in Personal and higher entitlements', async () => {
    const personal = baseStatus();
    personal.plan = 'personal';
    personal.status = 'valid';
    personal.entitlements = LICENSE_PLAN_ENTITLEMENTS.personal;
    const policy = new LicensePolicyService({ getStatus: vi.fn(async () => personal) } as never);

    await expect(policy.requireFeature('compose-applications')).resolves.toBeUndefined();
    expect(LICENSE_PLAN_ENTITLEMENTS.community.features).not.toContain('compose-applications');
    expect(LICENSE_PLAN_ENTITLEMENTS.personal.features).toContain('compose-applications');
    expect(LICENSE_PLAN_ENTITLEMENTS.business.features).toContain('compose-applications');
    expect(LICENSE_PLAN_ENTITLEMENTS.enterprise.features).toContain('compose-applications');
  });

  it('includes Git push-to-deploy in Business and Enterprise v4 entitlements only', async () => {
    const business = baseStatus();
    business.plan = 'business';
    business.status = 'valid';
    business.entitlements = LICENSE_PLAN_ENTITLEMENTS.business;
    const policy = new LicensePolicyService({ getStatus: vi.fn(async () => business) } as never);

    await expect(policy.requireFeature('git-push-to-deploy')).resolves.toBeUndefined();
    expect(LICENSE_PLAN_ENTITLEMENTS.community.features).not.toContain('git-push-to-deploy');
    expect(LICENSE_PLAN_ENTITLEMENTS.personal.features).not.toContain('git-push-to-deploy');
    expect(LICENSE_PLAN_ENTITLEMENTS.business.features).toContain('git-push-to-deploy');
    expect(LICENSE_PLAN_ENTITLEMENTS.enterprise.features).toContain('git-push-to-deploy');
    expect(LICENSE_PLAN_ENTITLEMENTS_V3.business.features).not.toContain('git-push-to-deploy');
    expect(LICENSE_PLAN_ENTITLEMENTS_V3.enterprise.features).not.toContain('git-push-to-deploy');
  });

  it('keeps legacy paid features available from a canonical v3 cache while denying Compose', async () => {
    const status = baseStatus();
    status.plan = 'personal';
    status.status = 'valid_with_warning';
    status.licensed = true;
    status.entitlementsVersion = 3;
    status.entitlements = LICENSE_PLAN_ENTITLEMENTS_V3.personal;
    status.lastValidAt = '2026-08-24T12:00:00.000Z';
    status.offlineGraceUntil = '2026-09-23T12:00:00.000Z';
    status.errorMessage = 'License server is unavailable';
    const policy = new LicensePolicyService({ getStatus: vi.fn(async () => status) } as never);

    await expect(policy.requireFeature('managed-databases')).resolves.toBeUndefined();
    await expect(policy.requireFeature('compose-applications')).rejects.toMatchObject({
      statusCode: 403,
      code: 'LICENSE_ENTITLEMENT_REQUIRED',
    });
  });

  it('requires Personal or higher without changing signed feature entitlements', async () => {
    const communityPolicy = new LicensePolicyService({ getStatus: vi.fn(async () => baseStatus()) } as never);
    await expect(communityPolicy.requireMinimumPlan('personal')).rejects.toMatchObject({
      statusCode: 403,
      code: 'LICENSE_ENTITLEMENT_REQUIRED',
      details: { requiredPlan: 'personal', currentPlan: 'community', licenseStatus: 'community' },
    });

    const business = baseStatus();
    business.plan = 'business';
    business.status = 'valid';
    business.entitlements = LICENSE_PLAN_ENTITLEMENTS.business;
    const businessPolicy = new LicensePolicyService({ getStatus: vi.fn(async () => business) } as never);
    await expect(businessPolicy.requireMinimumPlan('personal')).resolves.toBeUndefined();
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

  it('fails closed when a non-active state carries paid entitlements', async () => {
    const status = baseStatus();
    status.status = 'revoked';
    status.plan = 'enterprise';
    status.licensed = false;
    status.entitlements = LICENSE_PLAN_ENTITLEMENTS.enterprise;
    const policy = new LicensePolicyService({ getStatus: vi.fn(async () => status) } as never);

    await expect(policy.requireFeature('internal-pki')).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
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
    expect(summary).toMatchObject({ plan: 'community', entitlementsVersion: 4 });
  });
});
