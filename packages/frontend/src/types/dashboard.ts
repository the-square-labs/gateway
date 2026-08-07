import type { CA, Node, ProxyHost } from "@/types";
import type { InferenceSelfUsage } from "@/types/inference";

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

export type DashboardAttentionSeverity = "info" | "warning";

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
  } | null;
  update: { updateAvailable?: boolean; latestVersion?: string } | null;
  loggingHealth: unknown | null;
  inferenceUsage: InferenceSelfUsage | null;
  inviteUserMethods: { password: boolean; emailOtp: boolean } | null;
  pinned: {
    dashboard: DashboardBootstrapPinnedResources;
    sidebar: DashboardBootstrapPinnedResources;
  };
  attention: {
    severity: DashboardAttentionSeverity | null;
    notices: Array<{ id: string; severity: DashboardAttentionSeverity }>;
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
