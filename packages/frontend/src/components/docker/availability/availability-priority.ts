import type { DockerAvailabilityPolicy } from "@/types";

/**
 * The order the priority list shows and saves: the stored order limited to eligible nodes, then every other
 * eligible node in its listed order. The first node is the primary.
 */
export function effectivePriorityOrder(
  nodePriority: string[],
  eligibleNodeIds: string[]
): string[] {
  const eligible = new Set(eligibleNodeIds);
  const ranked = [...new Set(nodePriority)].filter((nodeId) => eligible.has(nodeId));
  const rankedSet = new Set(ranked);
  return [...ranked, ...eligibleNodeIds.filter((nodeId) => !rankedSet.has(nodeId))];
}

/** Moves one node up (-1) or down (+1); a move past either end leaves the order unchanged. */
export function movePriorityNode(order: string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta;
  if (index < 0 || index >= order.length || target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[index], next[target]] = [next[target] as string, next[index] as string];
  return next;
}

/** "Primary" for the first node, "Backup 1..n" for the rest. */
export function priorityRoleLabel(index: number): string {
  return index === 0 ? "Primary" : `Backup ${index}`;
}

export interface AvailabilityPriorityState {
  primaryNodeId: string | null;
  /** Serving nodes with their role; a node outside the order is "Not ranked". */
  serving: { nodeId: string; role: string }[];
  /** Some serving placement is not on one of the desired highest-priority nodes. */
  onBackup: boolean;
}

/** Which node is primary and whether the workload currently serves from a backup. Null without priority mode. */
export function availabilityPriorityState(
  policy: Pick<
    DockerAvailabilityPolicy,
    "mode" | "priorityMode" | "nodePriority" | "desiredReplicaCount" | "placements"
  >
): AvailabilityPriorityState | null {
  if (!policy.priorityMode || policy.mode === "single") return null;
  const desired = policy.mode === "replicated" ? policy.desiredReplicaCount : 1;
  const preferred = new Set(policy.nodePriority.slice(0, desired));
  const serving = policy.placements
    .filter((placement) => placement.serving && placement.actualState === "serving")
    .map((placement) => {
      const index = policy.nodePriority.indexOf(placement.nodeId);
      const role = index === -1 ? "Not ranked" : priorityRoleLabel(index);
      return {
        nodeId: placement.nodeId,
        role,
        rank: index === -1 ? Number.POSITIVE_INFINITY : index,
      };
    })
    .sort((left, right) => (left.rank === right.rank ? 0 : left.rank < right.rank ? -1 : 1))
    .map(({ nodeId, role }) => ({ nodeId, role }));
  return {
    primaryNodeId: policy.nodePriority[0] ?? null,
    serving,
    onBackup: serving.some((entry) => !preferred.has(entry.nodeId)),
  };
}
