export const LICENSE_SERVER_URL = 'https://license.wiolett.cloud';
export const LICENSE_ENTITLEMENTS_VERSION = 2;
export const LICENSE_OFFLINE_GRACE_DAYS = 30;
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

export const COMMUNITY_ENTITLEMENTS: LicenseEntitlements = {
  managedNodes: 100,
  users: 10,
  customPermissionGroups: 5,
  supportLevel: 'community',
  features: [
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
  ],
};
