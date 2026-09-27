import { describe, expect, it } from "vitest";
import type { DockerAvailabilityPlacement } from "@/types";
import {
  availabilityPriorityState,
  effectivePriorityOrder,
  movePriorityNode,
  priorityRoleLabel,
} from "./availability-priority";

function serving(nodeId: string): DockerAvailabilityPlacement {
  return { nodeId, serving: true, actualState: "serving" } as DockerAvailabilityPlacement;
}

describe("priority order", () => {
  it("keeps the stored order of eligible nodes and appends the other eligible nodes", () => {
    expect(effectivePriorityOrder(["b", "gone", "a"], ["a", "b", "c"])).toEqual(["b", "a", "c"]);
    expect(effectivePriorityOrder([], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("moves a node up or down and ignores moves past either end", () => {
    const order = ["a", "b", "c"];
    expect(movePriorityNode(order, 2, -1)).toEqual(["a", "c", "b"]);
    expect(movePriorityNode(order, 0, 1)).toEqual(["b", "a", "c"]);
    expect(movePriorityNode(order, 0, -1)).toBe(order);
    expect(movePriorityNode(order, 2, 1)).toBe(order);
  });

  it("labels the first node Primary and the rest Backup 1..n", () => {
    expect([0, 1, 2].map(priorityRoleLabel)).toEqual(["Primary", "Backup 1", "Backup 2"]);
  });
});

describe("priority summary state", () => {
  const base = {
    mode: "failover" as const,
    priorityMode: true,
    nodePriority: ["good", "weak"],
    desiredReplicaCount: 1,
  };

  it("reports a failover workload running on its backup", () => {
    expect(availabilityPriorityState({ ...base, placements: [serving("weak")] })).toEqual({
      primaryNodeId: "good",
      serving: [{ nodeId: "weak", role: "Backup 1" }],
      onBackup: true,
    });
  });

  it("reports a workload on its primary", () => {
    expect(availabilityPriorityState({ ...base, placements: [serving("good")] })?.onBackup).toBe(
      false
    );
  });

  it("treats replicas outside the first desired nodes as backups", () => {
    const state = availabilityPriorityState({
      ...base,
      mode: "replicated",
      desiredReplicaCount: 2,
      nodePriority: ["a", "b", "c"],
      placements: [serving("x"), serving("a")],
    });
    expect(state?.serving).toEqual([
      { nodeId: "a", role: "Primary" },
      { nodeId: "x", role: "Not ranked" },
    ]);
    expect(state?.onBackup).toBe(true);
  });

  it("is empty without priority mode", () => {
    expect(
      availabilityPriorityState({ ...base, priorityMode: false, placements: [serving("weak")] })
    ).toBeNull();
  });
});
