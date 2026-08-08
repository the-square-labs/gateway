import { describe, expect, it, vi } from "vitest";
import {
  effectiveNodeStatus,
  getNodeUpdateTargetVersion,
  hasGpuMonitoringMetrics,
  isNodeIncompatible,
  isNodeUpdating,
  type Node,
  type NodeGpuDevice,
} from "./nodes";

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    id: "node-1",
    type: "docker",
    hostname: "docker-1",
    displayName: null,
    appearanceColor: null,
    status: "online",
    serviceCreationLocked: false,
    daemonVersion: "1.2.3",
    osInfo: null,
    configVersionHash: null,
    capabilities: {},
    lastSeenAt: "2026-06-21T00:00:00.000Z",
    metadata: {},
    isConnected: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    ...overrides,
    slug: overrides.slug ?? "docker-1",
  };
}

function gpu(availableMetrics: string[]): NodeGpuDevice {
  return {
    id: "nvidia:GPU-1",
    vendor: "nvidia",
    model: "RTX",
    pciAddress: "0000:01:00.0",
    renderNode: "",
    deviceIndex: 0,
    attachable: true,
    unavailableReason: "",
    partitioned: false,
    availableMetrics,
  };
}

describe("node type helpers", () => {
  it("reads compatibility and update metadata flags from node payloads", () => {
    expect(isNodeIncompatible(makeNode())).toBe(false);
    expect(isNodeIncompatible(makeNode({ capabilities: { versionMismatch: true } }))).toBe(true);

    expect(isNodeUpdating(makeNode())).toBe(false);
    expect(isNodeUpdating(makeNode({ metadata: { updateInProgress: true } }))).toBe(true);

    expect(getNodeUpdateTargetVersion(makeNode())).toBeNull();
    expect(
      getNodeUpdateTargetVersion(makeNode({ metadata: { updateTargetVersion: "" } }))
    ).toBeNull();
    expect(
      getNodeUpdateTargetVersion(makeNode({ metadata: { updateTargetVersion: "2.0.0" } }))
    ).toBe("2.0.0");
  });

  it("degrades online nodes when recent health history contains offline or degraded samples", () => {
    vi.setSystemTime(new Date("2026-06-21T12:00:00.000Z"));
    try {
      expect(
        effectiveNodeStatus({
          status: "offline",
          healthHistory: [{ ts: "2026-06-21T12:00:00.000Z", status: "online" }],
        })
      ).toBe("offline");
      expect(
        effectiveNodeStatus({
          status: "online",
          healthHistory: [{ ts: "2026-06-21T11:54:00.000Z", status: "offline" }],
        })
      ).toBe("online");
      expect(
        effectiveNodeStatus({
          status: "online",
          healthHistory: [{ ts: "2026-06-21T11:59:00.000Z", status: "degraded" }],
        })
      ).toBe("degraded");
      expect(
        effectiveNodeStatus({
          status: "online",
          healthHistory: [{ ts: "2026-06-21T11:59:00.000Z", status: "online" }],
        })
      ).toBe("online");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GPU monitoring helpers", () => {
  it("does not render a GPU monitoring section from inventory or health metadata alone", () => {
    expect(hasGpuMonitoringMetrics(gpu([]))).toBe(false);
    expect(hasGpuMonitoringMetrics(gpu(["health"]))).toBe(false);
  });

  it("renders when at least one displayable GPU metric was actually reported", () => {
    expect(hasGpuMonitoringMetrics(gpu(["temperature_celsius"]))).toBe(true);
  });
});
