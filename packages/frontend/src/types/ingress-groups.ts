/** Ingress groups: nginx nodes (normally one per site) that serve the same routes and domains. */
export type IngressGroupMemberState = "joining" | "active" | "draining";

export interface IngressHealthReport {
  serving: boolean;
  reason: string;
  configGeneration: number;
  nginxRunning: boolean;
  configApplied: boolean;
  secureLinkSources: number;
  usableRelayTransports: number;
  checkedAt: string | null;
}

export interface IngressGroupMember {
  nodeId: string;
  priority: number;
  state: IngressGroupMemberState;
  drainStartedAt: string | null;
  lastError: string | null;
  node: {
    id: string;
    slug: string;
    hostname: string;
    displayName: string | null;
    status: string;
    connected: boolean;
    capable: boolean;
    addresses: string[];
  } | null;
  health: IngressHealthReport | null;
  delivery: { ready: number; pending: number; failed: number };
}

export interface IngressGroup {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  folderId: string | null;
  dnsFailoverMode: "none";
  dnsFailoverNote: string;
  createdAt: string;
  updatedAt: string;
  members: IngressGroupMember[];
  routeCount: number;
  domainCount: number;
  healthy: boolean;
}

export type IngressMemberDeliveryStatus = "pending" | "ready" | "failed" | "disabled";

export interface IngressMemberDelivery {
  nodeId: string;
  status: IngressMemberDeliveryStatus;
  desiredConfigHash: string | null;
  appliedConfigHash: string | null;
  appliedCertificateVersion: string | null;
  certificateCurrent: boolean;
  lastError: string | null;
  appliedAt: string | null;
}

export interface IngressGroupRoute {
  id: string;
  slug: string;
  domainNames: string[];
  enabled: boolean;
  healthStatus: string | null;
  isSystem: boolean;
  currentCertificateVersion: string | null;
  members: IngressMemberDelivery[];
}

export interface IngressGroupDomain {
  id: string;
  domain: string;
  dnsProvider: "cloudflare" | "external";
  dnsStatus: string;
  dnsTargetIps: string[];
  dnsProxied: boolean | null;
  dnsTtl: number | null;
}

export interface IngressGroupDetail extends IngressGroup {
  routes: IngressGroupRoute[];
  domains: IngressGroupDomain[];
}

export interface CreateIngressGroupRequest {
  name: string;
  description?: string | null;
  folderId?: string | null;
  /** Members in site-preference order (the first one is preferred). */
  nodeIds: string[];
}

export interface UpdateIngressGroupRequest {
  name?: string;
  description?: string | null;
  folderId?: string | null;
  dnsFailoverMode?: "none";
}

/** An ingress group offered as the destination of a new route or domain (no node permission needed). */
export interface IngressGroupDestination<TMember> {
  id: string;
  name: string;
  slug: string;
  dnsFailoverMode: string;
  members: Array<TMember & { state: IngressGroupMemberState }>;
}

export type RouteIngressGroupOption = IngressGroupDestination<{
  id: string;
  displayName: string | null;
  hostname: string;
  status: string;
}>;

export type DomainIngressGroupOption = IngressGroupDestination<{
  id: string;
  displayName: string | null;
  hostname: string;
  effectiveAddress: string;
}>;

/** Where a route is served: its nodes and, on an ingress group, the group and per-member delivery. */
export interface RouteIngressPlacementView {
  servingNodeIds?: string[];
  ingressGroup?: {
    id: string;
    name: string;
    slug: string;
    dnsFailoverMode: string;
    members: Array<{ nodeId: string; state: IngressGroupMemberState; priority: number }>;
  } | null;
  ingressDelivery?: Array<Omit<IngressMemberDelivery, "certificateCurrent">>;
}
