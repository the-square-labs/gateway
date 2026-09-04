export const LICENSE_SERVER_URL = 'https://license.thesqlabs.com';
export const LICENSE_LEGACY_ENTITLEMENTS_VERSION = 3;
export const LICENSE_ENTITLEMENTS_VERSION = 4;
export const LICENSE_OFFLINE_GRACE_DAYS = 100;
export const LICENSE_PAID_HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;
export const LICENSE_COMMUNITY_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
export const LICENSE_SCHEDULER_INTERVAL_MS = LICENSE_PAID_HEARTBEAT_INTERVAL_MS;

export type LicensePlan = 'community' | 'personal' | 'business' | 'enterprise';
export type LicenseRegistrationStatus = 'registered' | 'pending';

export type LicenseStatus =
  | 'community'
  | 'valid'
  | 'expired_grace'
  | 'valid_with_warning'
  | 'unreachable_grace_expired'
  | 'invalid'
  | 'expired'
  | 'revoked'
  | 'replaced'
  | 'deactivated';

export interface EncryptedLicenseCredential {
  encryptedKey: string;
  encryptedDek: string;
}

export interface LicenseEntitlements {
  managedNodes: number | null;
  users: number | null;
  customPermissionGroups: number | null;
  supportLevel: string;
  features: string[];
}

export interface CachedLicenseState {
  registrationStatus: LicenseRegistrationStatus;
  status: LicenseStatus;
  plan: LicensePlan;
  paidPlan: Exclude<LicensePlan, 'community'> | null;
  paidLicenseStatus: string;
  licenseName: string | null;
  licenseMetadata: Record<string, unknown>;
  expiresAt: string | null;
  graceUntil: string | null;
  entitlementsVersion: number;
  entitlements: LicenseEntitlements;
  lastCheckedAt: string | null;
  lastValidAt: string | null;
  activeInstallationId: string | null;
  activeInstallationName: string | null;
  errorMessage: string | null;
}

export interface LicenseStatusView {
  status: LicenseStatus;
  plan: LicensePlan;
  registrationStatus: LicenseRegistrationStatus;
  paidLicenseStatus: string;
  licensed: boolean;
  hasKey: boolean;
  keyLast4: string | null;
  licenseName: string | null;
  licenseMetadata: Record<string, unknown>;
  installationId: string;
  installationName: string;
  expiresAt: string | null;
  entitlementsVersion: number;
  entitlements: LicenseEntitlements;
  lastCheckedAt: string | null;
  lastValidAt: string | null;
  graceUntil: string | null;
  offlineGraceUntil: string | null;
  activeInstallationId: string | null;
  activeInstallationName: string | null;
  errorMessage: string | null;
  serverUrl: string;
}

export interface LicenseServerPaidLicense {
  id: string;
  status: 'active' | 'expired' | 'revoked';
  plan: Exclude<LicensePlan, 'community'>;
  name: string;
  expiresAt: string | null;
  keyLast4: string;
  metadata: Record<string, unknown>;
}

export interface LicenseServerState {
  registrationStatus: 'registered';
  effectivePlan: LicensePlan;
  paidLicenseStatus: string;
  paidLicense?: LicenseServerPaidLicense;
  graceUntil: string | null;
  entitlementsVersion: number;
  entitlements: LicenseEntitlements;
  activation?: {
    installationId: string;
    installationName: string;
    activatedAt: string;
    lastHeartbeatAt: string | null;
  };
  serverTime: string;
}

export interface LicenseServerRegistration {
  installationToken: string;
  state: LicenseServerState;
}

export interface LicenseServerEnvelope<T> {
  data: T;
}

export interface LicenseServerErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

const SHARED_FEATURES = [
  'infrastructure',
  'nginx',
  'docker',
  'tls',
  'domains',
  'monitoring',
  'auth',
  'rbac',
  'audit',
  'api',
  'oauth',
  'mcp',
  'gitlab',
  'ai-workspace',
  'gateway-inference',
  'signed-updates',
] as const;

const PERSONAL_FEATURES_V3 = [
  ...SHARED_FEATURES,
  'container-export',
  'blue-green',
  'cross-node-migration',
  'managed-databases',
  'status-pages',
  'registry-discovery',
  'pages',
] as const;

const PERSONAL_FEATURES = [...PERSONAL_FEATURES_V3, 'compose-applications'] as const;

const BUSINESS_FEATURES_V3 = [
  ...PERSONAL_FEATURES_V3,
  'secure-runtime',
  'structured-logging',
  'audit-export',
  'security-scanning',
  'guided-onboarding',
] as const;

const BUSINESS_FEATURES = [
  ...PERSONAL_FEATURES,
  'git-push-to-deploy',
  'multi-node-availability',
  'secure-runtime',
  'structured-logging',
  'audit-export',
  'security-scanning',
  'guided-onboarding',
] as const;

const ENTERPRISE_FEATURES_V3 = [
  ...BUSINESS_FEATURES_V3,
  'internal-pki',
  'siem-export',
  'oidc-group-mapping',
  'scim',
  'dedicated-contact',
  'assisted-migration',
] as const;

export const COMMUNITY_ENTITLEMENTS: LicenseEntitlements = {
  managedNodes: 100,
  users: 10,
  customPermissionGroups: 5,
  supportLevel: 'community',
  features: [...SHARED_FEATURES],
};

export const LICENSE_PLAN_ENTITLEMENTS: Record<LicensePlan, LicenseEntitlements> = {
  community: COMMUNITY_ENTITLEMENTS,
  personal: {
    managedNodes: null,
    users: null,
    customPermissionGroups: null,
    supportLevel: 'standard',
    features: [...PERSONAL_FEATURES],
  },
  business: {
    managedNodes: null,
    users: null,
    customPermissionGroups: null,
    supportLevel: 'priority',
    features: [...BUSINESS_FEATURES],
  },
  enterprise: {
    managedNodes: null,
    users: null,
    customPermissionGroups: null,
    supportLevel: 'priority-dedicated',
    features: [
      ...BUSINESS_FEATURES,
      'internal-pki',
      'siem-export',
      'oidc-group-mapping',
      'scim',
      'dedicated-contact',
      'assisted-migration',
    ],
  },
};

export const LICENSE_PLAN_ENTITLEMENTS_V3: Record<LicensePlan, LicenseEntitlements> = {
  community: COMMUNITY_ENTITLEMENTS,
  personal: {
    managedNodes: null,
    users: null,
    customPermissionGroups: null,
    supportLevel: 'standard',
    features: [...PERSONAL_FEATURES_V3],
  },
  business: {
    managedNodes: null,
    users: null,
    customPermissionGroups: null,
    supportLevel: 'priority',
    features: [...BUSINESS_FEATURES_V3],
  },
  enterprise: {
    managedNodes: null,
    users: null,
    customPermissionGroups: null,
    supportLevel: 'priority-dedicated',
    features: [...ENTERPRISE_FEATURES_V3],
  },
};

export function isCanonicalEntitlements(
  plan: LicensePlan,
  value: unknown,
  version = LICENSE_ENTITLEMENTS_VERSION
): value is LicenseEntitlements {
  const contracts: Partial<Record<number, Record<LicensePlan, LicenseEntitlements>>> = {
    [LICENSE_LEGACY_ENTITLEMENTS_VERSION]: LICENSE_PLAN_ENTITLEMENTS_V3,
    [LICENSE_ENTITLEMENTS_VERSION]: LICENSE_PLAN_ENTITLEMENTS,
  };
  const expected = contracts[version]?.[plan];
  if (
    !expected ||
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as Partial<LicenseEntitlements>).features)
  ) {
    return false;
  }
  const entitlements = value as LicenseEntitlements;
  return (
    entitlements.managedNodes === expected.managedNodes &&
    entitlements.users === expected.users &&
    entitlements.customPermissionGroups === expected.customPermissionGroups &&
    entitlements.supportLevel === expected.supportLevel &&
    entitlements.features.length === expected.features.length &&
    new Set(entitlements.features).size === entitlements.features.length &&
    entitlements.features.every((feature) => expected.features.includes(feature))
  );
}
