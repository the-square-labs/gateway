import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Node, NodeHealthReport } from "@/types";

vi.mock("@/components/ui/health-bars", () => ({
  HealthBars: ({ history }: { history?: unknown[] }) => (
    <div data-testid="health-bars" data-history-count={history?.length ?? 0} />
  ),
}));

import { PinnedNodeCard } from "./PinnedNodeCard";

const health: NodeHealthReport = {
  nginxRunning: true,
  configValid: true,
  nginxUptimeSeconds: 60,
  workerCount: 1,
  nginxVersion: "1.27.0",
  cpuPercent: 25,
  memoryBytes: 0,
  diskFreeBytes: 0,
  timestamp: Date.now(),
  loadAverage1m: 0,
  loadAverage5m: 0,
  loadAverage15m: 0,
  systemMemoryTotalBytes: 100,
  systemMemoryUsedBytes: 83,
  systemMemoryAvailableBytes: 17,
  swapTotalBytes: 0,
  swapUsedBytes: 0,
  systemUptimeSeconds: 60,
  openFileDescriptors: 10,
  maxFileDescriptors: 1_024,
  diskMounts: [
    {
      mountPoint: "/",
      filesystem: "ext4",
      device: "/dev/test",
      totalBytes: 100,
      usedBytes: 84,
      freeBytes: 16,
      usagePercent: 84,
    },
  ],
  diskReadBytes: 0,
  diskWriteBytes: 0,
  networkInterfaces: [],
  localIpAddresses: [],
  nginxRssBytes: 0,
  errorRate4xx: 0,
  errorRate5xx: 0,
};

const node: Node = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "warning-node",
  type: "docker",
  hostname: "warning-node",
  displayName: "Warning node",
  appearanceColor: null,
  status: "online",
  serviceCreationLocked: false,
  daemonVersion: "2.6.0",
  osInfo: null,
  configVersionHash: null,
  capabilities: {},
  lastSeenAt: new Date().toISOString(),
  lastHealthReport: health,
  healthHistory: [
    { ts: new Date(Date.now() - 1_000).toISOString(), status: "online" },
    { ts: new Date().toISOString(), status: "online" },
  ],
  metadata: {},
  isConnected: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("PinnedNodeCard", () => {
  it("keeps the shared border neutral between adjacent warning metrics", () => {
    render(
      <MemoryRouter>
        <PinnedNodeCard node={node} />
      </MemoryRouter>
    );

    const memoryCard = screen.getByText("Memory").parentElement?.parentElement
      ?.parentElement as HTMLElement;
    const diskCard = screen.getByText("Disk").parentElement?.parentElement
      ?.parentElement as HTMLElement;

    expect(memoryCard.style.borderTop).toContain("--color-warning");
    expect(memoryCard.style.borderRight).toBe("");
    expect(diskCard.style.borderTop).toContain("--color-warning");
    expect(diskCard.style.borderLeft).toBe("");
  });

  it("uses the bootstrap health history when no live override is provided", () => {
    render(
      <MemoryRouter>
        <PinnedNodeCard node={node} />
      </MemoryRouter>
    );

    expect(screen.getByTestId("health-bars")).toHaveAttribute(
      "data-history-count",
      String(node.healthHistory?.length ?? 0)
    );
  });
});
