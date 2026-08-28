// Status Page
export type StatusPageSourceType =
  | "node"
  | "proxy_host"
  | "database"
  | "docker_container"
  | "docker_deployment"
  | "docker_compose_project"
  | "pages_project";
export type StatusPageServiceStatus =
  | "operational"
  | "degraded"
  | "outage"
  | "unknown"
  | "maintenance";
export type StatusPageIncidentSeverity = "info" | "warning" | "critical";
export type StatusPageIncidentStatus = "active" | "resolved";
export type StatusPageIncidentType = "automatic" | "manual";
export type StatusPageIncidentUpdateStatus =
  | "update"
  | "investigating"
  | "identified"
  | "monitoring"
  | "resolved";

export interface StatusPageConfig {
  enabled: boolean;
  title: string;
  description: string;
  domain: string;
  nodeId: string | null;
  sslCertificateId: string | null;
  proxyTemplateId: string | null;
  upstreamUrl: string | null;
  proxyHostId: string | null;
  publicIncidentLimit: number;
  recentIncidentDays: number;
  autoDegradedEnabled: boolean;
  autoOutageEnabled: boolean;
  autoDegradedSeverity: StatusPageIncidentSeverity;
  autoOutageSeverity: StatusPageIncidentSeverity;
  autoCreateThresholdSeconds: number;
  autoResolveThresholdSeconds: number;
}

export interface StatusPageProxyTemplateOption {
  id: string;
  name: string;
}

export interface StatusPageServiceItem {
  id: string;
  sourceType: StatusPageSourceType;
  sourceId: string;
  publicName: string;
  publicDescription: string | null;
  publicGroup: string | null;
  sortOrder: number;
  enabled: boolean;
  createThresholdSeconds: number;
  resolveThresholdSeconds: number;
  lastEvaluatedStatus: string;
  unhealthySince: string | null;
  healthySince: string | null;
  createdAt: string;
  updatedAt: string;
  source: { label: string; status: StatusPageServiceStatus; rawStatus: string } | null;
  currentStatus: StatusPageServiceStatus;
  broken: boolean;
}

export interface StatusPageIncidentUpdate {
  id: string;
  incidentId?: string;
  status: StatusPageIncidentUpdateStatus;
  message: string;
  createdAt: string;
}

export interface StatusPageIncident {
  id: string;
  title: string;
  message: string;
  severity: StatusPageIncidentSeverity;
  status: StatusPageIncidentStatus;
  type: StatusPageIncidentType;
  autoManaged: boolean;
  affectedServiceIds: string[];
  startedAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  updates: StatusPageIncidentUpdate[];
}

export interface PublicStatusPageDto {
  title: string;
  description: string;
  generatedAt: string;
  overallStatus: "operational" | "degraded" | "outage" | "maintenance";
  services: Array<{
    id: string;
    name: string;
    description: string | null;
    group: string | null;
    status: StatusPageServiceStatus;
    healthHistory: Array<{ ts: string; status: StatusPageServiceStatus }>;
  }>;
  incidents: Array<{
    id: string;
    title: string;
    message: string;
    severity: StatusPageIncidentSeverity;
    status: StatusPageIncidentStatus;
    type: StatusPageIncidentType;
    startedAt: string;
    resolvedAt: string | null;
    affectedServiceIds: string[];
    updates: Array<{
      id: string;
      status: StatusPageIncidentUpdateStatus;
      message: string;
      createdAt: string;
    }>;
  }>;
}
