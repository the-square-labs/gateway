import type { NodeDetail, NodeType, UpdateStatus } from "@/types";

export const DEV_FORCE_UPDATES_STORAGE_KEY = "gateway-dev-force-updates";

const FORCED_GATEWAY_VERSION = "v9.9.9";
const FORCED_DAEMON_VERSION = "9.9.9";
const DAEMON_NODE_TYPES = new Set<NodeType>(["nginx", "docker", "databases", "monitoring"]);

export function isDevForceUpdatesEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  const stored = window.localStorage.getItem(DEV_FORCE_UPDATES_STORAGE_KEY);
  if (stored === "0") return false;
  if (stored === "1") return true;
  return import.meta.env.MODE === "development";
}

export function applyForcedGatewayUpdateStatus(status: UpdateStatus): UpdateStatus {
  if (!isDevForceUpdatesEnabled()) return status;
  return {
    ...status,
    latestVersion: FORCED_GATEWAY_VERSION,
    updateAvailable: true,
    releaseNotes: status.releaseNotes ?? "Local dev preview update.",
    lastCheckedAt: status.lastCheckedAt ?? new Date().toISOString(),
  };
}

export function getForcedDaemonUpdateForNode(
  node: NodeDetail | null
): { available: boolean; latestVersion: string | null } | null {
  if (!isDevForceUpdatesEnabled() || !node || !DAEMON_NODE_TYPES.has(node.type)) return null;
  return {
    available: true,
    latestVersion: FORCED_DAEMON_VERSION,
  };
}
