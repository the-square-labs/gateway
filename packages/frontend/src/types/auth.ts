import type { AIApprovalMode } from "@/lib/ai-approval-mode";

// User
export interface User {
  id: string;
  oidcSubject: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  groupId: string;
  groupName: string;
  groupScopes?: string[];
  additionalScopes?: string[];
  scopes: string[];
  isBlocked: boolean;
  aiApprovalMode?: AIApprovalMode;
  folderId?: string | null;
  sortOrder?: number;
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
  mcpServerEnabled: boolean;
  mcpExtendedCompatibility: boolean;
  generalSettings: {
    fileUploadMaxBytes: number;
    fileOpenMaxBytes: number;
    gatewayPublicIps: string[];
    gatewayGrpcPublicTarget: string | null;
    gatewayGrpcLocalIp: string | null;
    features: {
      pkiEnabled: boolean;
      domainsEnabled: boolean;
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
