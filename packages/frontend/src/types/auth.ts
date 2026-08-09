import type { AIApprovalMode } from "@/lib/ai-approval-mode";

// User
export interface User {
  id: string;
  oidcSubject: string | null;
  authMethod?: "oidc" | "password" | "email_otp";
  email: string;
  name: string | null;
  avatarUrl: string | null;
  groupId: string;
  groupName: string;
  groupScopes?: string[];
  additionalScopes?: string[];
  scopes: string[];
  isBlocked: boolean;
  isDeleted?: boolean;
  aiApprovalMode?: AIApprovalMode;
  folderId?: string | null;
  sortOrder?: number;
}

export interface DeletedUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  deletedAt: string;
  deletedByUserId: string | null;
  deletedFromGroupId: string | null;
  originalGroupExists: boolean;
}

export interface BrowserSession {
  id: string;
  authMethod: "oidc" | "password" | "email_otp";
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ipAddress: string | null;
  userAgent: string | null;
  mfaSatisfiedAt: number | null;
  isCurrent: boolean;
}

// Permission Group
export interface PermissionGroup {
  id: string;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  parentId: string | null;
  folderId?: string | null;
  sortOrder?: number;
  scopes: string[];
  requireGateway2fa?: boolean;
  inheritedScopes?: string[];
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuthProvisioningGroupOption {
  id: string;
  name: string;
  isBuiltin: boolean;
}

export interface AuthProvisioningSettings {
  oidcAutoCreateUsers: boolean;
  oidcDefaultGroupId: string;
  oidcRequireVerifiedEmail: boolean;
  oauthExtendedCallbackCompatibility: boolean;
  mfaExistingSessionGracePeriodDays: number;
  methods?: {
    oidc: boolean;
    password: boolean;
    emailOtp: boolean;
    passkeyLogin: boolean;
  };
  passwordPolicy?: {
    minLength: number;
    maxLength: number;
    requireUppercase: boolean;
    requireLowercase: boolean;
    requireDigit: boolean;
    requireSymbol: boolean;
  };
  smtp?: {
    configured: boolean;
    host: string | null;
    port: number | null;
    tlsMode: "starttls" | "tls" | null;
    username: string | null;
    passwordLast4: string | null;
    senderName: string | null;
    senderEmail: string | null;
    verifiedAt: string | null;
  };
  oidc?: {
    configured: boolean;
    issuer: string | null;
    clientId: string | null;
    clientSecretLast4: string | null;
    redirectUri: string | null;
    scopes: string;
  };
  logging?: {
    mode: "disabled" | "local" | "external";
    url: string;
    username: string;
    passwordLast4: string | null;
    database: string;
    table: string;
    requestTimeoutMs: number;
  };
  mcpServerEnabled: boolean;
  mcpExtendedCompatibility: boolean;
  webTransport?: {
    tlsEnabled: boolean;
    restartRequired: boolean;
    directAccess: boolean;
    targetUrl: string | null;
  };
  generalSettings: {
    publicUrl: string | null;
    fileUploadMaxBytes: number;
    fileOpenMaxBytes: number;
    gatewayPublicIps: string[];
    gatewayGrpcPublicTarget: string | null;
    gatewayGrpcLocalIp: string | null;
    relayAutoRecovery: boolean;
    shutdown: {
      userRequestDrainSeconds: number;
      structuredLogDrainSeconds: number;
      finalizationTimeoutSeconds: number;
    };
    features: {
      pkiEnabled: boolean;
      domainsEnabled: boolean;
      siemEnabled: boolean;
      inferenceEnabled: boolean;
    };
  };
  networkSecurity: {
    clientIpSource: "auto" | "direct" | "reverse_proxy" | "cloudflare";
    trustedProxyCidrs: string[];
    trustCloudflareHeaders: boolean;
  };
  outboundWebhookPolicy: {
    allowPrivateNetworks: boolean;
    allowedPrivateCidrs: string[];
  };
  currentRequestIp: {
    ipAddress?: string;
    remoteAddress?: string;
    source: "remote" | "cloudflare" | "forwarded" | "real-ip" | "unknown";
    warning?: string;
  };
  availableGroups: AuthProvisioningGroupOption[];
}

export interface OAuthConsentPreview {
  requestId: string;
  client: {
    id: string;
    name: string;
    uri: string | null;
    logoUri: string | null;
  };
  account: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
  };
  requestedScopes: string[];
  grantableScopes: string[];
  unavailableScopes: string[];
  manualApprovalScopes: string[];
  redirect: {
    uri: string;
    isExternal: boolean;
  };
  resource: string;
  resourceInfo: {
    resource: string;
    name: string;
    description: string;
  };
  expiresAt: string;
}

export interface OAuthAuthorization {
  clientId: string;
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  scopes: string[];
  resource: string;
  resources: string[];
  activeAccessTokens: number;
  activeRefreshTokens: number;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface ApiToken {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  createdAt: string;
}
