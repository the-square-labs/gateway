export type NodeType =
  | "nginx"
  | "bastion"
  | "monitoring"
  | "docker"
  | "builder"
  | "databases"
  | "storage"
  | "relay";
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
  managedStorageCapacity?: {
    storageRoot: string;
    availableBytes: number;
  };
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

export interface NodeMonitoringSnapshot {
  timestamp: string;
  health: NodeHealthReport | null;
  stats: NodeStatsReport | null;
  traffic: {
    statusCodes: { s2xx: number; s3xx: number; s4xx: number; s5xx: number };
    avgResponseTime: number;
    p95ResponseTime: number;
    totalRequests: number;
  } | null;
}

export interface Node {
  id: string;
  slug: string;
  type: NodeType;
  hostname: string;
  displayName: string | null;
  appearanceColor: NodeAppearanceColor | null;
  serviceAddresses?: string[];
  serviceAddress?: string | null;
  secondaryServiceAddress?: string | null;
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
  /** Away only because the local relay restarts, or restarted moments ago; not its own failure. */
  reconnecting?: boolean;
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
  monitoringHistory?: NodeMonitoringSnapshot[];
}

/** A node setup command for one enrollment target, built by Gateway for its own release. */
export interface NodeInstallCommand {
  target: "public" | "local";
  label: string;
  gateway: string;
  curl: string;
  wget: string;
}

export interface NodeInstallation {
  /** Gateway release the installers come from; null for an unreleased build, which uses main. */
  installerRelease: string | null;
  installCommands: NodeInstallCommand[];
}

export interface CreateNodeResponse extends NodeInstallation {
  node: Node;
  enrollmentToken: string;
  /** ISO timestamp after which an unused enrollment token is rejected. */
  enrollmentTokenExpiresAt?: string;
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

function nodeUpdateMetadata(node: Node | NodeDetail): Record<string, unknown> {
  return (node.metadata as Record<string, unknown> | undefined) ?? {};
}

/** An update runs (or waits for its lease peers) and its deadline has not passed. */
export function isNodeUpdating(node: Node | NodeDetail): boolean {
  const metadata = nodeUpdateMetadata(node);
  if (metadata.updateInProgress !== true) return false;
  // A deadline that passed while Gateway could not expire the update (a restart) no longer holds the node.
  const deadlineAt =
    typeof metadata.updateDeadlineAt === "string"
      ? Date.parse(metadata.updateDeadlineAt)
      : Number.NaN;
  return !(Number.isFinite(deadlineAt) && Date.now() >= deadlineAt);
}

/** The update waits until the other members of the node's availability leases settled. */
export function isNodeUpdateQueued(node: Node | NodeDetail): boolean {
  return isNodeUpdating(node) && nodeUpdateMetadata(node).updatePhase === "waiting_for_lease_peers";
}

/** Lease members a queued update waits for, with the reason each one blocks it. */
export function getNodeUpdateWaitingFor(
  node: Node | NodeDetail
): Array<{ memberId: string; reason: string }> {
  const waitingFor = nodeUpdateMetadata(node).updateWaitingFor;
  if (!Array.isArray(waitingFor)) return [];
  return waitingFor.flatMap((entry) =>
    entry &&
    typeof entry === "object" &&
    typeof (entry as { memberId?: unknown }).memberId === "string"
      ? [
          {
            memberId: (entry as { memberId: string }).memberId,
            reason: String((entry as { reason?: unknown }).reason ?? ""),
          },
        ]
      : []
  );
}

/** Why the last daemon update of the node did not complete, while no newer update runs. */
export function getNodeUpdateLastError(
  node: Node | NodeDetail
): { message: string; at: string | null } | null {
  const metadata = nodeUpdateMetadata(node);
  if (isNodeUpdating(node) || typeof metadata.updateLastError !== "string") return null;
  return {
    message: metadata.updateLastError,
    at: typeof metadata.updateLastErrorAt === "string" ? metadata.updateLastErrorAt : null,
  };
}

export function getNodeUpdateTargetVersion(node: Node | NodeDetail): string | null {
  const target = (node.metadata as Record<string, unknown> | undefined)?.updateTargetVersion;
  return typeof target === "string" && target.length > 0 ? target : null;
}

/** Effective node status from recent health history; the Dashboard dot uses the same rule. */
export { effectiveNodeStatus } from "@/lib/dashboard-attention";
