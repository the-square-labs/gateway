import type { NodeAppearanceColor } from "./nodes";
import type { CertificateDistributionState, SSLCertificate } from "./ssl";

// Proxy Host Types
export type ProxyHostType = "proxy" | "redirect" | "404" | "raw";
export type ForwardScheme = "http" | "https";
export type ProxyUpstreamKind = "manual" | "docker_container" | "docker_deployment";
export type HealthStatus = "online" | "offline" | "degraded" | "unknown" | "disabled";

export interface CustomHeader {
  name: string;
  value: string;
}

export interface CacheOptions {
  maxAge?: number;
  staleWhileRevalidate?: number;
}

export interface RateLimitOptions {
  requestsPerSecond: number;
  burst?: number;
  connectionsPerIp?: number;
}

export type RateLimitMode = "inherit" | "custom" | "disabled";

export interface RewriteRule {
  source: string;
  destination: string;
  type: "permanent" | "temporary";
}

export interface ProxyHost {
  id: string;
  slug: string;
  type: ProxyHostType;
  domainNames: string[];
  enabled: boolean;
  maintenanceEnabled: boolean;
  maintenanceStartedAt: string | null;
  nodeId?: string | null;
  upstreamKind?: ProxyUpstreamKind;
  forwardHost: string | null;
  forwardPort: number | null;
  forwardScheme: ForwardScheme;
  dockerNodeId?: string | null;
  dockerNodeSlug?: string | null;
  dockerContainerName?: string | null;
  dockerDeploymentId?: string | null;
  dockerDeploymentName?: string | null;
  dockerNodeAppearanceColor?: NodeAppearanceColor | null;
  dockerContainerPort?: number | null;
  dockerHostPort?: number | null;
  dockerProtocol?: "tcp" | null;
  secureLinkActive?: boolean;
  sslEnabled: boolean;
  sslForced: boolean;
  http2Support: boolean;
  sslCertificateId: string | null;
  internalCertificateId: string | null;
  websocketSupport: boolean;
  redirectUrl: string | null;
  redirectStatusCode: number;
  customHeaders: CustomHeader[];
  cacheEnabled: boolean;
  cacheOptions: CacheOptions | null;
  rateLimitEnabled: boolean;
  rateLimitMode?: RateLimitMode;
  rateLimitOptions: RateLimitOptions | null;
  customRewrites: RewriteRule[];
  advancedConfig: string | null;
  rawConfig: string | null;
  rawConfigEnabled: boolean;
  accessListId: string | null;
  folderId: string | null;
  sortOrder: number;
  nginxTemplateId: string | null;
  templateVariables: Record<string, string | number | boolean>;
  healthCheckEnabled: boolean;
  healthCheckUrl: string;
  healthCheckInterval: number;
  healthCheckExpectedStatus: number | null;
  healthCheckExpectedBody: string | null;
  healthCheckBodyMatchMode: "includes" | "exact" | "starts_with" | "ends_with";
  healthCheckSlowThreshold: number | null;
  healthStatus: HealthStatus;
  effectiveHealthStatus?: string;
  lastHealthCheckAt: string | null;
  healthHistory?: Array<{ ts: string; status: string; responseMs?: number; slow?: boolean }>;
  isSystem?: boolean;
  systemKind?: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  // Relations (populated in detail views)
  sslCertificate?: SSLCertificate;
  tlsDistribution?: CertificateDistributionState | null;
  accessList?: AccessList;
}

export interface ProxySecureLinkStatus {
  state: string;
  generation: number;
  sourceNodeId: string | null;
  targetNodeId: string | null;
  transport: string;
  migratedAt: string | null;
  lastError: string | null;
  healthCheck: {
    enabled: boolean;
    intervalSeconds: number;
  };
  sourceNode: { id: string; name: string; status: string } | null;
  targetNode: { id: string; name: string; status: string } | null;
  rateLimit: {
    mode: RateLimitMode;
    enabled: boolean;
    requestsPerSecond: number;
    burst: number;
    connectionsPerIp: number;
  };
  runtime: {
    routeId: string;
    activeStreams: number;
    openedTotal: string;
    completedTotal: string;
    failedTotal: string;
    throttledTotal: string;
    sourceToTargetBytes: string;
    targetToSourceBytes: string;
    setupLatencyP95Ms: number;
    averageDurationMs: number;
    lastActivityAt: string | null;
    metricsSince: string;
  } | null;
  traffic: {
    hostId: string;
    statusCodes: { s2xx: number; s3xx: number; s4xx: number; s5xx: number };
    avgResponseTime: number;
    p95ResponseTime: number;
    totalRequests: number;
    totalBytes: number;
    requestsPerSecond: number;
    bytesPerSecond: number;
    busiestClientRps: number;
    windowSeconds: number;
    sampleTruncated: boolean;
    lastRequestAt?: string;
  } | null;
  history: Array<{
    timestamp: string;
    runtime: ProxySecureLinkStatus["runtime"];
    traffic: ProxySecureLinkStatus["traffic"];
  }>;
  additionalLinks?: ProxyAdditionalSecureLinkRuntime[];
}

export interface ProxyAdditionalSecureLinkRuntime {
  id: string;
  name: string;
  status: ProxyAdditionalSecureLinkStatus;
  generation: number;
  targetContainer: string;
  forwardScheme: ForwardScheme;
  lastError: string | null;
  runtime: ProxySecureLinkStatus["runtime"];
  history: Array<{
    timestamp: string;
    runtime: ProxySecureLinkStatus["runtime"];
  }>;
}

export type ProxyAdditionalSecureLinkStatus =
  | "provisioning"
  | "active"
  | "failed"
  | "cleanup_pending";

export interface ProxyAdditionalSecureLink {
  id: string;
  proxyHostId: string;
  name: string;
  upstreamKind: "docker_container" | "docker_deployment";
  forwardScheme: ForwardScheme;
  sourceNodeId: string;
  dockerNodeId: string;
  dockerContainerName: string | null;
  dockerDeploymentId: string | null;
  dockerContainerPort: number;
  dockerHostPort: number;
  targetContainer: string;
  generation: number;
  status: ProxyAdditionalSecureLinkStatus;
  lastError: string | null;
  listenerPort: number | null;
  connectorPort: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProxyAdditionalSecureLinkRequest {
  name: string;
  upstreamKind: "docker_container" | "docker_deployment";
  forwardScheme: ForwardScheme;
  dockerNodeId?: string | null;
  dockerContainerName?: string | null;
  dockerDeploymentId?: string | null;
  dockerContainerPort: number;
}

// Access List Types
export interface IPRule {
  type: "allow" | "deny";
  value: string;
}

export interface BasicAuthUser {
  username: string;
}

export interface AccessList {
  id: string;
  name: string;
  description: string | null;
  ipRules: IPRule[];
  basicAuthEnabled: boolean;
  basicAuthUsers: BasicAuthUser[];
  createdAt: string;
  updatedAt: string;
  usageCount?: number;
}

// Request types (Gateway)
export interface CreateProxyHostRequest {
  type: ProxyHostType;
  nodeId: string;
  domainNames: string[];
  upstreamKind?: ProxyUpstreamKind;
  forwardHost?: string;
  forwardPort?: number;
  forwardScheme?: ForwardScheme;
  dockerNodeId?: string | null;
  dockerContainerName?: string | null;
  dockerDeploymentId?: string | null;
  dockerContainerPort?: number | null;
  dockerHostPort?: number | null;
  dockerProtocol?: "tcp" | null;
  sslEnabled?: boolean;
  sslForced?: boolean;
  http2Support?: boolean;
  sslCertificateId?: string | null;
  internalCertificateId?: string | null;
  websocketSupport?: boolean;
  redirectUrl?: string;
  redirectStatusCode?: number;
  customHeaders?: CustomHeader[];
  cacheEnabled?: boolean;
  cacheOptions?: CacheOptions;
  rateLimitEnabled?: boolean;
  rateLimitMode?: RateLimitMode;
  rateLimitOptions?: RateLimitOptions;
  customRewrites?: RewriteRule[];
  advancedConfig?: string | null;
  rawConfig?: string;
  rawConfigEnabled?: boolean;
  accessListId?: string | null;
  folderId?: string | null;
  nginxTemplateId?: string | null;
  templateVariables?: Record<string, string | number | boolean>;
  healthCheckEnabled?: boolean;
  healthCheckUrl?: string;
  healthCheckInterval?: number;
  healthCheckExpectedStatus?: number | null;
  healthCheckExpectedBody?: string | null;
  healthCheckBodyMatchMode?: "includes" | "exact" | "starts_with" | "ends_with" | null;
  healthCheckSlowThreshold?: number | null;
}

// Proxy Host Folder Types
export interface ProxyHostFolder {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  depth: number;
  createdAt: string;
  updatedAt: string;
}

export interface FolderTreeNode extends ProxyHostFolder {
  children: FolderTreeNode[];
  hosts: ProxyHost[];
}

export interface GroupedProxyHostsResponse {
  folders: FolderTreeNode[];
  ungroupedHosts: ProxyHost[];
  totalHosts: number;
}

// Nginx Config Template Types
export interface TemplateVariableDef {
  name: string;
  type: "string" | "number" | "boolean";
  default?: string | number | boolean;
  description?: string;
}

export interface NginxTemplate {
  id: string;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  type: ProxyHostType;
  content: string;
  variables: TemplateVariableDef[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccessListRequest {
  name: string;
  description?: string;
  ipRules: IPRule[];
  basicAuthEnabled?: boolean;
  basicAuthUsers?: { username: string; password: string }[];
}
