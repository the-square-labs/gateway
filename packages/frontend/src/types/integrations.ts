export type IntegrationProvider = "gitlab" | "cloudflare";
export type GitConnectorProvider = "github" | "git";
export type GitConnectorMode = "single_repository" | "multi_repository";

export interface GitConnector {
  id: string;
  provider: GitConnectorProvider;
  name: string;
  baseUrl: string;
  enabled: boolean;
  authMode: "token" | "oauth";
  username: string | null;
  allowlistMode: GitLabAllowlistMode;
  capabilities: Record<string, boolean>;
  settings?: {
    repositoryMode: GitConnectorMode;
    autoSyncEnabled: boolean;
    autoSyncIntervalSeconds: number;
  };
  syncStatus: IntegrationSyncStatus;
  syncLastError?: string | null;
  syncFinishedAt?: string | null;
  testedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  tokenMasked?: string | null;
  hasToken: boolean;
  allowlistEntries?: GitLabAllowlistEntry[];
}

export interface GitConnectorRequest {
  name: string;
  baseUrl: string;
  enabled: boolean;
  authMode?: "token";
  username?: string;
  token: string;
  allowlistEntries: GitLabAllowlistEntry[];
}

export interface GitHubTokenConnectorRequest {
  name: string;
  baseUrl: string;
  enabled: boolean;
  authMode?: "token";
  token: string;
}

export type GitConnectorCreateRequest = GitConnectorRequest | GitHubTokenConnectorRequest;

export interface GitHubConnectorPreviewTestRequest {
  baseUrl: string;
  token: string;
}

export interface GitHubConnectorPreviewTestResult {
  success: true;
  baseUrl: string;
  username: string;
  capabilities: Record<string, boolean>;
}

export interface GitConnectorPreviewTestRequest {
  baseUrl: string;
  repositoryUrl: string;
  username: string;
  token: string;
}

export interface GitConnectorPreviewTestResult {
  success: true;
  baseUrl: string;
  capabilities: Record<string, boolean>;
}

export interface GitHubOAuthStartRequest {
  connectorId?: string;
  name: string;
  enabled: boolean;
}

export interface GitHubOAuthSession {
  id: string;
  status: "pending" | "processing" | "complete" | "expired" | "cancelled" | "error";
  userCode: string;
  verificationUri: string;
  pollIntervalSeconds: number;
  expiresAt: string;
  connectorId: string | null;
  errorMessage: string | null;
}

export interface GitUserCredentialStatus {
  provider: GitConnectorProvider;
  connectorId: string;
  connectorName: string;
  baseUrl: string;
  authorized: boolean;
  status: "missing" | "valid" | "invalid";
  tokenMasked: string | null;
  username: string | null;
  authorizationUrl: string | null;
}

export interface ExternalSshConnector {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "private_key";
  hostFingerprint: string;
  jumpConnectorId: string | null;
  enabled: boolean;
  testStatus: "never" | "success" | "error";
  testLastError: string | null;
  testedAt: string | null;
}

export interface ExternalSshConnectorRequest {
  name: string;
  host: string;
  port?: number;
  username: string;
  authMethod: "password" | "private_key";
  secret?: string;
  hostFingerprint: string;
  jumpConnectorId?: string | null;
  enabled?: boolean;
  generatePrivateKey?: boolean;
  reuseCredentialFromConnectorId?: string;
}

export interface ExternalSshHostKeyRequest {
  host: string;
  port?: number;
  jumpConnectorId?: string | null;
}

export interface ExternalSshHostKeyResult {
  host: string;
  port: number;
  hostFingerprint: string;
}
export type GitLabAllowlistMode = "selected" | "all_visible";
export type GitLabAllowlistEntryType = "group" | "project";
export type IntegrationSyncStatus = "never" | "idle" | "running" | "success" | "error";

export interface GitLabConnectorSettings {
  autoSyncEnabled: boolean;
  autoSyncIntervalSeconds: number;
  cloneShallow: boolean;
  cloneDepth: number;
  cloneLfs: boolean;
  cloneSubmodules: boolean;
  cloneMaxSizeMb: number;
  cloneTimeoutSeconds: number;
}

export type GitLabConnectorCapabilities = Record<string, boolean>;
export type CloudflareConnectorCapabilities = Record<string, boolean>;

export interface GitLabAllowlistEntry {
  entryType: GitLabAllowlistEntryType;
  remoteId: string;
  fullPath: string;
  name?: string | null;
  webUrl?: string | null;
}

export interface GitLabConnector {
  id: string;
  provider: "gitlab";
  name: string;
  baseUrl: string;
  enabled: boolean;
  allowlistMode: GitLabAllowlistMode;
  settings: GitLabConnectorSettings;
  capabilities: GitLabConnectorCapabilities;
  syncStatus: IntegrationSyncStatus;
  syncLastError?: string | null;
  syncFailureCount: number;
  syncStartedAt?: string | null;
  syncFinishedAt?: string | null;
  syncLastOverlapAt?: string | null;
  syncNextRetryAt?: string | null;
  testedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  hasToken: boolean;
  tokenMasked?: string | null;
  allowlistEntries?: GitLabAllowlistEntry[];
}

export interface GitLabUserCredentialStatus {
  connectorId: string;
  connectorName: string;
  baseUrl: string;
  patCreationUrl: string;
  authorized: boolean;
  status: "missing" | "valid" | "invalid";
  tokenMasked: string | null;
  gitlabUserId: string | null;
  gitlabUsername: string | null;
  tokenScopes: string[];
  tokenExpiresAt: string | null;
  lastValidatedAt: string | null;
}

export interface CloudflareConnectorSettings {
  autoSyncEnabled: boolean;
  autoSyncIntervalSeconds: number;
  defaultTtl: number;
  defaultProxied: boolean;
}

export interface CloudflareZone {
  id: string;
  connectorId: string;
  remoteId: string;
  name: string;
  status: string | null;
  accountName: string | null;
  permissions: string[];
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloudflareConnector {
  id: string;
  provider: "cloudflare";
  name: string;
  baseUrl: string | null;
  enabled: boolean;
  settings: CloudflareConnectorSettings;
  capabilities: CloudflareConnectorCapabilities;
  syncStatus: IntegrationSyncStatus;
  syncLastError?: string | null;
  syncFailureCount: number;
  syncStartedAt?: string | null;
  syncFinishedAt?: string | null;
  syncLastOverlapAt?: string | null;
  syncNextRetryAt?: string | null;
  testedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  hasToken: boolean;
  tokenMasked?: string | null;
  zones?: CloudflareZone[];
}

export interface GitLabConnectorSyncResult {
  status: "success" | "skipped";
  reason?: string;
  projectCount?: number;
  registryCount?: number;
}

export interface CloudflareConnectorSyncResult {
  status: "success" | "skipped";
  reason?: string;
  zoneCount?: number;
}

export interface CloudflareConnectorPreviewTestRequest {
  token: string;
}

export interface CloudflareConnectorPreviewTestResult {
  capabilities: CloudflareConnectorCapabilities;
  zones: CloudflareZone[];
}

export interface CloudflareConnectorCreateRequest {
  name: string;
  enabled: boolean;
  token: string;
  settings?: Partial<CloudflareConnectorSettings>;
}

export interface CloudflareConnectorUpdateRequest {
  name?: string;
  enabled?: boolean;
  settings?: Partial<CloudflareConnectorSettings>;
}

export interface GitLabConnectorPreviewTestRequest {
  baseUrl: string;
  token: string;
}

export interface GitLabConnectorPreviewTestResult {
  capabilities: GitLabConnectorCapabilities;
  allowlistEntries: GitLabAllowlistEntry[];
}

export interface GitLabConnectorCreateRequest {
  name: string;
  baseUrl: string;
  enabled: boolean;
  token: string;
  allowlistMode: GitLabAllowlistMode;
  settings?: Partial<GitLabConnectorSettings>;
  allowlistEntries?: GitLabAllowlistEntry[];
}

export interface GitLabAllowlistPreviewSearchRequest {
  baseUrl: string;
  token: string;
  q: string;
}

export interface GitLabConnectorUpdateRequest {
  name?: string;
  baseUrl?: string;
  enabled?: boolean;
  token?: string;
  allowlistMode?: GitLabAllowlistMode;
  settings?: Partial<GitLabConnectorSettings>;
  allowlistEntries?: GitLabAllowlistEntry[];
}
