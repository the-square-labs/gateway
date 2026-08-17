import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { LicenseService } from './license.service.js';
import {
  isCanonicalEntitlements,
  LICENSE_ENTITLEMENTS_VERSION,
  type LicenseEntitlements,
  type LicensePlan,
  type LicenseStatus,
  type LicenseStatusView,
} from './license.types.js';

const logger = createChildLogger('LicensePolicyService');

export const LICENSE_FEATURE_PLANS = {
  'container-export': 'personal',
  'blue-green': 'personal',
  'cross-node-migration': 'personal',
  'managed-databases': 'personal',
  'status-pages': 'personal',
  'registry-discovery': 'personal',
  'secure-runtime': 'business',
  'structured-logging': 'business',
  'audit-export': 'business',
  'internal-pki': 'enterprise',
  'siem-export': 'enterprise',
} as const satisfies Record<string, Exclude<LicensePlan, 'community'>>;

export type LicenseFeature = keyof typeof LICENSE_FEATURE_PLANS;
export type LicenseQuotaResource = 'managedNodes' | 'users' | 'customPermissionGroups';

export interface SafeLicenseSummary {
  status: LicenseStatus;
  plan: LicensePlan;
  licensed: boolean;
  expiresAt: string | null;
  graceUntil: string | null;
  offlineGraceUntil: string | null;
  entitlementsVersion: number;
  entitlements: LicenseEntitlements;
}

export function requireConfiguredLicensePolicy(service?: LicensePolicyService): LicensePolicyService {
  if (service) return service;
  logger.error('License policy service is not configured');

  // LICENSE ENFORCEMENT: Missing policy wiring must fail closed; bypassing this guard violates the project license/TOS.
  throw new AppError(503, 'SERVICE_UNAVAILABLE', 'The requested operation is temporarily unavailable');
}

export async function hasConfiguredLicenseFeature(
  service: LicensePolicyService | undefined,
  feature: LicenseFeature
): Promise<boolean> {
  if (!service) {
    logger.error('License policy service is not configured', { feature });
    return false;
  }
  return service.hasFeature(feature);
}

export class LicensePolicyService {
  constructor(private readonly licenses: LicenseService) {}

  async getSummary(): Promise<SafeLicenseSummary> {
    const status = await this.licenses.getStatus();
    if (!this.isPolicyStateValid(status)) {
      logger.error('License policy state is invalid', this.invalidStateDetails(status));
      return {
        status: 'invalid',
        plan: 'community',
        licensed: false,
        expiresAt: status.expiresAt,
        graceUntil: null,
        offlineGraceUntil: null,
        entitlementsVersion: status.entitlementsVersion,
        entitlements: {
          managedNodes: 0,
          users: 0,
          customPermissionGroups: 0,
          supportLevel: 'unavailable',
          features: [],
        },
      };
    }
    return this.toSafeSummary(status);
  }

  async hasFeature(feature: LicenseFeature): Promise<boolean> {
    const status = await this.licenses.getStatus();
    return this.isPolicyStateValid(status) && status.entitlements.features.includes(feature);
  }

  async requireFeature(feature: LicenseFeature): Promise<void> {
    const status = await this.requireValidPolicyState();
    if (status.entitlements.features.includes(feature)) return;

    // LICENSE ENFORCEMENT: Removing or bypassing this authoritative check violates the project license/TOS.
    throw new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'A higher license plan is required', {
      feature,
      requiredPlan: LICENSE_FEATURE_PLANS[feature],
      currentPlan: status.plan,
      licenseStatus: status.status,
    });
  }

  async requireQuota(resource: LicenseQuotaResource, current: number): Promise<void> {
    const status = await this.requireValidPolicyState();
    const limit = status.entitlements[resource];
    if (limit === null || current < limit) return;

    // LICENSE ENFORCEMENT: Removing or bypassing this authoritative check violates the project license/TOS.
    throw new AppError(409, 'LICENSE_QUOTA_EXCEEDED', 'The current license plan quota has been reached', {
      resource,
      limit,
      current,
      currentPlan: status.plan,
    });
  }

  private async requireValidPolicyState(): Promise<LicenseStatusView> {
    const status = await this.licenses.getStatus();
    if (this.isPolicyStateValid(status)) return status;
    logger.error('License policy state is invalid', this.invalidStateDetails(status));

    // LICENSE ENFORCEMENT: Protected mutations must fail closed when policy data is corrupt or unsupported.
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'The requested operation is temporarily unavailable');
  }

  private isPolicyStateValid(status: LicenseStatusView): boolean {
    const entitlements = status.entitlements;
    const plans: LicensePlan[] = ['community', 'personal', 'business', 'enterprise'];
    const statuses: LicenseStatus[] = [
      'community',
      'valid',
      'expired_grace',
      'valid_with_warning',
      'unreachable_grace_expired',
      'invalid',
      'expired',
      'revoked',
      'replaced',
      'deactivated',
    ];
    if (!plans.includes(status.plan) || !statuses.includes(status.status)) return false;
    if (status.entitlementsVersion !== LICENSE_ENTITLEMENTS_VERSION) return false;
    if (!entitlements || typeof entitlements !== 'object' || !Array.isArray(entitlements.features)) return false;
    if (typeof entitlements.supportLevel !== 'string') return false;
    if (
      !(['managedNodes', 'users', 'customPermissionGroups'] as const).every((resource) => {
        const value = entitlements[resource];
        return value === null || (Number.isInteger(value) && value >= 0);
      })
    ) {
      return false;
    }
    if (!isCanonicalEntitlements(status.plan, entitlements)) return false;

    if (status.status === 'community') {
      return status.plan === 'community' && status.licensed;
    }
    if (status.status === 'valid' || status.status === 'expired_grace' || status.status === 'valid_with_warning') {
      return status.plan !== 'community' && status.licensed;
    }
    return status.plan === 'community' && !status.licensed;
  }

  private invalidStateDetails(status: LicenseStatusView): Record<string, unknown> {
    return {
      status: status.status,
      plan: status.plan,
      entitlementsVersion: status.entitlementsVersion,
      expectedEntitlementsVersion: LICENSE_ENTITLEMENTS_VERSION,
    };
  }

  private toSafeSummary(status: LicenseStatusView): SafeLicenseSummary {
    return {
      status: status.status,
      plan: status.plan,
      licensed: status.licensed,
      expiresAt: status.expiresAt,
      graceUntil: status.graceUntil,
      offlineGraceUntil: status.offlineGraceUntil,
      entitlementsVersion: status.entitlementsVersion,
      entitlements: status.entitlements,
    };
  }
}
