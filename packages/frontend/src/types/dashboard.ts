import type { CA, Node, ProxyHost } from "@/types";
import type { InferenceSelfUsage } from "@/types/inference";
import type { UpdateStatus } from "@/types/system";

// Dashboard Stats
export interface DashboardStats {
  proxyHosts: {
    total: number;
    enabled: number;
    online: number;
    offline: number;
    degraded: number;
  };
  sslCertificates: {
    total: number;
    active: number;
    expiringSoon: number;
    expired: number;
  };
  pkiCertificates: {
    total: number;
    active: number;
    revoked: number;
    expired: number;
  };
  cas: {
    total: number;
    active: number;
  };
}

export type DashboardAttentionSeverity = "info" | "warning" | "critical";
export type NavigationAttentionSeverity = "warning" | "critical";

export type RelayLifecycleState =
  | "migration_pending"
  | "maintenance"
  | "healthy"
  | "suspect"
  | "degraded"
  | "recovering"
  | "critical"
  | "unavailable"
  | "rebalancing"
  | "rebalance_available";

export interface DashboardRelaySnapshot {
  state: RelayLifecycleState;
  impact: string | null;
  attempt: number;
  maxAttempts: 3;
  lastHealthyAt: string | null;
  reason?: string | null;
  lastProbeAt?: string | null;
  attemptHistory?: Array<{
    attempt: number;
    startedAt: string;
    action?: "start" | "restart" | "compose_up";
    result: "running" | "failed" | "healthy";
  }>;
  relayBuildVersion?: string | null;
  protocolMajor?: number | null;
  registeredEndpoints?: number;
  activeTunnels?: number;
  activeProxyTunnels?: number;
  activeDatabaseTunnels?: number;
  throttledProxyTotal?: number;
  throttledDatabaseTotal?: number;
  pressurePercent?: number;
  cpuPressurePercent?: number;
  memoryPressurePercent?: number;
  fdPressurePercent?: number;
  admissionState?: string;
  memoryRssBytes?: number;
  heapInUseBytes?: number;
  memoryLimitBytes?: number;
  openFileDescriptors?: number;
  fileDescriptorLimit?: number;
  expectedService?: string;
  expectedImage?: string | null;
  expectedVersion?: string | null;
  canRetry?: boolean;
  poolId?: string;
  rebalanceAvailable?: boolean;
  worstPressurePercent?: number;
  endpointCount?: number;
  instances?: DashboardRelayInstance[];
  staging?: Array<{ id: string; endpointId: string; generation: number; state: string }>;
  update?: { state: string; targetVersion: string; error: string | null } | null;
  local?: DashboardRelaySnapshot | null;
}

export interface DashboardRelayInstance {
  id: string;
  kind: "local" | "remote";
  nodeId: string | null;
  faultDomainId: string;
  displayName: string;
  advertisedAddresses: string[];
  servicePort: number;
  state: "joining" | "synchronizing" | "ready" | "draining" | "offline" | "error";
  buildVersion: string | null;
  protocolMajor: number | null;
  appliedPolicyRevision: number;
  policyExpiresAt: string | null;
  lastSeenAt: string | null;
  activeAssignments: number;
  updateStep?: { state: string; error: string | null } | null;
  health?: {
    activeTunnels?: number;
    registeredEndpoints?: number;
    pressurePercent?: number;
  } | null;
}

export interface DashboardPinnedDockerResourceRequest {
  id: string;
  nodeId: string;
  kind: "container" | "deployment";
  scopeResourceId?: string;
}

export interface DashboardBootstrapRequest {
  showSystemCertificates?: boolean;
  showUpdateNotifications?: boolean;
  pins?: {
    dashboard?: {
      nodeIds?: string[];
      proxyHostIds?: string[];
      databaseIds?: string[];
      dockerResources?: DashboardPinnedDockerResourceRequest[];
    };
    sidebar?: {
      nodeIds?: string[];
      proxyHostIds?: string[];
      databaseIds?: string[];
      dockerResources?: DashboardPinnedDockerResourceRequest[];
    };
  };
}

export interface DashboardBootstrap {
  fetchedAt: string;
  stats: DashboardStats;
  health: Array<{
    id: string;
    domainNames: string[];
    type: string;
    enabled: boolean;
    healthStatus: string | null;
    lastHealthCheckAt: string | null;
  }>;
  requestedPins: Required<NonNullable<DashboardBootstrapRequest["pins"]>>;
  nodes: Node[];
  expiring: Array<{
    id: string;
    name: string;
    type: "ssl" | "pki" | "ca";
    expiresAt: string;
  }>;
  cas: CA[];
  activity: unknown[];
  finalizeSetup: unknown | null;
  mfa: {
    totpConfigured: boolean;
    passkeyCount: number;
    recoveryCodeCount: number;
    required: boolean;
    showReminder: boolean;
    sessionMfaSatisfied: boolean;
    graceExpiresAt: number | null;
  } | null;
  update: UpdateStatus | null;
  loggingHealth: unknown | null;
  inferenceUsage: InferenceSelfUsage | null;
  inviteUserMethods: { password: boolean; emailOtp: boolean } | null;
  relay: DashboardRelaySnapshot | null;
  pinned: {
    dashboard: DashboardBootstrapPinnedResources;
    sidebar: DashboardBootstrapPinnedResources;
  };
  attention: {
    severity: DashboardAttentionSeverity | null;
    notices: Array<{ id: string; severity: DashboardAttentionSeverity }>;
  };
  navigationAttention: {
    nodes: NavigationAttentionSeverity | null;
    "proxy-hosts": NavigationAttentionSeverity | null;
    docker: NavigationAttentionSeverity | null;
  };
}

export interface DashboardBootstrapPinnedResources {
  nodes: Node[];
  proxies: ProxyHost[];
  databases: Array<{
    id: string;
    slug: string;
    name: string;
    type: string;
    healthStatus?: string | null;
  }>;
  dockerResources: Array<{
    id: string;
    nodeId: string;
    nodeSlug: string;
    name: string;
    state?: string;
    kind: "container" | "deployment";
    scopeResourceId?: string;
  }>;
}
