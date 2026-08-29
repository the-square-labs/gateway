import { describe, expect, it } from "vitest";
import type { Node } from "@/types";
import { sortDashboardNodes } from "./NodesCard";

describe("sortDashboardNodes", () => {
  it("puts problematic nodes before online nodes without mutating the snapshot", () => {
    const nodes = [
      { id: "online-a", displayName: "Alpha", hostname: "alpha", status: "online" },
      { id: "pending-b", displayName: "Beta", hostname: "beta", status: "pending" },
      { id: "error-c", displayName: "Charlie", hostname: "charlie", status: "error" },
      { id: "offline-z", displayName: "Zulu", hostname: "zulu", status: "offline" },
      {
        id: "degraded-d",
        displayName: "Delta",
        hostname: "delta",
        status: "online",
        healthHistory: [{ ts: new Date().toISOString(), status: "offline" }],
      },
    ] as Node[];

    expect(sortDashboardNodes(nodes).map((node) => node.id)).toEqual([
      "error-c",
      "offline-z",
      "degraded-d",
      "pending-b",
      "online-a",
    ]);
    expect(nodes.map((node) => node.id)).toEqual([
      "online-a",
      "pending-b",
      "error-c",
      "offline-z",
      "degraded-d",
    ]);
  });
});
