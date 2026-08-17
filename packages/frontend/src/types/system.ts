// System Update
export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseNotes: string | null;
  releaseUrl: string | null;
  lastCheckedAt: string | null;
  relay: RelayUpdateStatus;
}

export interface RelayUpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseNotes: string | null;
  releaseUrl: string | null;
  operation: {
    status: "updating" | "failed";
    targetVersion: string;
    startedAt: string;
    error: string | null;
  } | null;
}

export interface SystemConfig {
  publicUrl?: string | null;
  fileUploadMaxBytes: number;
  fileOpenMaxBytes: number;
  gatewayGrpcPublicTarget: string | null;
  gatewayGrpcLocalIp: string | null;
  relayAutoRecovery: boolean;
  features: GatewayFeatureConfig;
}

export interface GatewayFeatureConfig {
  pkiEnabled: boolean;
  domainsEnabled: boolean;
  siemEnabled: boolean;
  loggingEnabled: boolean;
  inferenceEnabled: boolean;
}

export type LicensePlan = "community" | "personal" | "business" | "enterprise";

export type LicenseRegistrationStatus = "registered" | "pending";

export type LicenseStatus =
  | "community"
  | "valid"
  | "valid_with_warning"
  | "unreachable_grace_expired"
  | "invalid"
  | "expired"
  | "revoked"
  | "replaced"
  | "deactivated";

export interface LicenseEntitlements {
  managedNodes: number | null;
  users: number | null;
  customPermissionGroups: number | null;
  supportLevel: string;
  features: string[];
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
  activeInstallationId: string | null;
  activeInstallationName: string | null;
  errorMessage: string | null;
  serverUrl: string;
}
