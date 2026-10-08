// Mirrors packages/backend/src/modules/monitoring/dashboard-attention.ts, which raises the sidebar
// Dashboard dot. The backend dashboard-attention.test.ts runs both over the same cases, so this
// module must stay free of runtime imports.

/** CPU, memory, or root disk usage at or above this percentage puts a node card on the Dashboard. */
export const NODE_CAPACITY_WARNING_PERCENT = 80;

type NodeCapacityHealth = {
  cpuPercent?: number | null;
  systemMemoryTotalBytes?: number | null;
  systemMemoryUsedBytes?: number | null;
  diskMounts?: ReadonlyArray<{ mountPoint: string; usagePercent?: number | null }> | null;
};

/** Which node metrics are at the capacity threshold, on the unrounded values. */
export function nodeCapacityWarnings(health: NodeCapacityHealth | null | undefined): {
  cpu: boolean;
  memory: boolean;
  disk: boolean;
} {
  if (!health) return { cpu: false, memory: false, disk: false };
  const memoryTotal = Number(health.systemMemoryTotalBytes ?? 0);
  const memory =
    memoryTotal > 0 ? (Number(health.systemMemoryUsedBytes ?? 0) / memoryTotal) * 100 : 0;
  const disk = health.diskMounts?.find((mount) => mount.mountPoint === "/");
  return {
    cpu: Number(health.cpuPercent ?? 0) >= NODE_CAPACITY_WARNING_PERCENT,
    memory: memory >= NODE_CAPACITY_WARNING_PERCENT,
    disk: Number(disk?.usagePercent ?? 0) >= NODE_CAPACITY_WARNING_PERCENT,
  };
}

const NODE_FLAP_WINDOW_MS = 5 * 60 * 1000;

/**
 * An online node that went offline or degraded in the last five minutes shows as degraded. One
 * away only because the local relay restarts (`reconnecting`) shows as reconnecting, which is not
 * a failure of its own.
 */
export function effectiveNodeStatus(
  node: {
    status: string;
    healthHistory?: ReadonlyArray<{ ts: string; status: string }> | null;
    reconnecting?: boolean;
  },
  now = Date.now()
): string {
  if (node.status === "online" && node.reconnecting) return "reconnecting";
  if (node.status !== "online" || !node.healthHistory?.length) return node.status;
  const since = now - NODE_FLAP_WINDOW_MS;
  const recent = node.healthHistory.filter(
    (entry) => entry.ts && new Date(entry.ts).getTime() >= since
  );
  if (recent.some((entry) => entry.status === "offline" || entry.status === "degraded")) {
    return "degraded";
  }
  return "online";
}

/** The Dashboard warns when less than this percentage of an inference quota window remains. */
export const INFERENCE_USAGE_WARNING_REMAINING_PERCENT = 20;

export type InferenceUsageWindowId = "api" | "5h" | "7d" | "30d";

type InferenceWindow = { configured: boolean; active?: boolean; percentage: number };

/**
 * Quota windows running low. A lazy window that has not started yet (`active: false`) holds no usage
 * and is never low.
 */
export function lowInferenceUsageWindows(
  usage: {
    enabled: boolean;
    api: InferenceWindow;
    subscription: Record<"5h" | "7d" | "30d", InferenceWindow>;
  } | null
): InferenceUsageWindowId[] {
  if (!usage?.enabled) return [];
  const windows: Array<[InferenceUsageWindowId, InferenceWindow]> = [
    ["api", usage.api],
    ["5h", usage.subscription["5h"]],
    ["7d", usage.subscription["7d"]],
    ["30d", usage.subscription["30d"]],
  ];
  return windows
    .filter(([, window]) => {
      if (!window.configured || window.active === false) return false;
      const remaining = Math.max(0, Math.min(100, 100 - window.percentage));
      return remaining < INFERENCE_USAGE_WARNING_REMAINING_PERCENT;
    })
    .map(([id]) => id);
}

/** The key the server uses for a pinned Docker resource in the `pinned-docker-health` notice. */
export function dockerResourceKey(resource: { id: string; nodeId: string; kind: string }): string {
  return `${resource.kind}:${resource.nodeId}:${resource.id}`;
}
