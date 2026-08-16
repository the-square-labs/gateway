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
  fileUploadMaxBytes: number;
  fileOpenMaxBytes: number;
  gatewayPublicIps: string[];
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

export type LicenseTier = "community" | "homelab" | "enterprise";

export type LicenseStatus =
  | "community"
  | "valid"
  | "valid_with_warning"
  | "unreachable_grace_expired"
  | "invalid"
  | "expired"
  | "revoked"
  | "replaced";

export interface LicenseStatusView {
  status: LicenseStatus;
  tier: LicenseTier;
  licensed: boolean;
  hasKey: boolean;
  keyLast4: string | null;
  licenseName: string | null;
  installationId: string;
  installationName: string;
  expiresAt: string | null;
  lastCheckedAt: string | null;
  lastValidAt: string | null;
  graceUntil: string | null;
  activeInstallationId: string | null;
  activeInstallationName: string | null;
  errorMessage: string | null;
  serverUrl: string;
}
