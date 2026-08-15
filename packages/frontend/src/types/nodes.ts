export type NodeType = "nginx" | "bastion" | "monitoring" | "docker" | "databases";
export type NodeStatus = "pending" | "online" | "offline" | "error";
export type NodeAppearanceColor =
  | "blue"
  | "red"
  | "green"
  | "yellow"
  | "purple"
  | "pink"
  | "orange";

export interface NodeGpuDevice {
  id: string;
  vendor: string;
  model: string;
  pciAddress: string;
  renderNode: string;
  deviceIndex: number;
  attachable: boolean;
  unavailableReason: string;
  partitioned: boolean;
  availableMetrics: string[];
  utilizationPercent?: number;
  memoryTotalBytes?: number;
  memoryUsedBytes?: number;
  temperatureCelsius?: number;
  powerWatts?: number;
  powerLimitWatts?: number;
  throttled?: boolean;
  eccCorrectedErrors?: number;
  eccUncorrectedErrors?: number;
  health?: string;
}

export function hasGpuMetric(device: NodeGpuDevice, metric: string): boolean {
  return device.availableMetrics.includes(metric);
}

const GPU_MONITORING_METRICS = [
  "utilization_percent",
  "memory_total_bytes",
  "memory_used_bytes",
  "temperature_celsius",
  "power_watts",
  "power_limit_watts",
];

/** A GPU section is useful only when the node actually reported a displayable metric. */
export function hasGpuMonitoringMetrics(device: NodeGpuDevice): boolean {
  return GPU_MONITORING_METRICS.some((metric) => hasGpuMetric(device, metric));
}

export function gpuDeviceLabel(
  device: Pick<NodeGpuDevice, "id" | "vendor" | "model" | "pciAddress">
): string {
  const vendor = device.vendor.trim() ? device.vendor.toUpperCase() : "GPU";
  return `${vendor} · ${device.model || device.pciAddress || device.id}`;
}

export interface NodeHealthReport {
  nginxRunning: boolean;
  configValid: boolean;
  nginxUptimeSeconds: number;
  workerCount: number;
  nginxVersion: string;
  cpuPercent: number;
  memoryBytes: number;
  diskFreeBytes: number;
  timestamp: number;
  // System
  loadAverage1m: number;
  loadAverage5m: number;
  loadAverage15m: number;
  systemMemoryTotalBytes: number;
  systemMemoryUsedBytes: number;
  systemMemoryAvailableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  systemUptimeSeconds: number;
  openFileDescriptors: number;
  maxFileDescriptors: number;
  // Disk
  diskMounts: Array<{
    mountPoint: string;
    filesystem: string;
    device: string;
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usagePercent: number;
  }>;
  diskReadBytes: number;
  diskWriteBytes: number;
  // Network
  networkInterfaces: Array<{
    name: string;
    rxBytes: number;
    txBytes: number;
    rxPackets: number;
    txPackets: number;
    rxErrors: number;
    txErrors: number;
    ipAddresses?: string[];
  }>;
  localIpAddresses: string[];
  publicIpAddresses?: string[];
  // Nginx
  nginxRssBytes: number;
  errorRate4xx: number;
  errorRate5xx: number;
  gpuDevices?: NodeGpuDevice[];
}

export interface NodeStatsReport {
  activeConnections: number;
  accepts: number;
  handled: number;
  requests: number;
  reading: number;
  writing: number;
  waiting: number;
  timestamp: number;
}

export interface Node {
  id: string;
  slug: string;
  type: NodeType;
  hostname: string;
  displayName: string | null;
  appearanceColor: NodeAppearanceColor | null;
  serviceAddress?: string | null;
  effectiveServiceAddress?: string | null;
  publicServiceAddresses?: string[];
  status: NodeStatus;
  serviceCreationLocked: boolean;
  daemonVersion: string | null;
  osInfo: string | null;
  configVersionHash: string | null;
  capabilities: Record<string, unknown>;
  lastSeenAt: string | null;
  lastHealthReport?: NodeHealthReport | null;
  lastStatsReport?: NodeStatsReport | null;
  healthHistory?: Array<{ ts: string; status: string }>;
  metadata: Record<string, unknown>;
  isConnected: boolean;
  folderId?: string | null;
  sortOrder?: number;
  createdAt: string;
  updatedAt: string;
}

export interface NodeDetail extends Node {
  lastHealthReport: NodeHealthReport | null;
  lastStatsReport: NodeStatsReport | null;
  liveHealthReport: NodeHealthReport | null;
  liveStatsReport: NodeStatsReport | null;
}

export interface CreateNodeResponse {
  node: Node;
  enrollmentToken: string;
  gatewayCertSha256: string;
  gatewayEnrollmentTargets?: {
    public?: {
      label: string;
      gateway: string | null;
    };
    local?: {
      label: string;
      gateway: string;
    };
  };
}

/** Check if a node is outside the supported gateway/daemon minor-version window. */
export function isNodeIncompatible(node: Node | NodeDetail): boolean {
  return !!(node.capabilities as Record<string, unknown>)?.versionMismatch;
}

export function isNodeUpdating(node: Node | NodeDetail): boolean {
  return (node.metadata as Record<string, unknown> | undefined)?.updateInProgress === true;
}

export function getNodeUpdateTargetVersion(node: Node | NodeDetail): string | null {
  const target = (node.metadata as Record<string, unknown> | undefined)?.updateTargetVersion;
  return typeof target === "string" && target.length > 0 ? target : null;
}

/** Compute effective node status from recent health history (mirrors proxy effectiveHealthStatus) */
export function effectiveNodeStatus(node: {
  status: NodeStatus;
  healthHistory?: Array<{ ts: string; status: string }>;
}): string {
  if (node.status !== "online" || !node.healthHistory?.length) return node.status;
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const recent = node.healthHistory.filter((h) => h.ts && new Date(h.ts).getTime() >= fiveMinAgo);
  if (recent.some((h) => h.status === "offline" || h.status === "degraded")) return "degraded";
  return "online";
}
