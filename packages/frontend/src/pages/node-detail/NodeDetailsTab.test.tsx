import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { NodeDetail, NodeHealthReport } from "@/types";
import { NodeDetailsTab } from "./NodeDetailsTab";

function createHealthReport(): NodeHealthReport {
  return {
    nginxRunning: false,
    configValid: false,
    nginxUptimeSeconds: 0,
    workerCount: 0,
    nginxVersion: "",
    cpuPercent: 0,
    memoryBytes: 0,
    diskFreeBytes: 0,
    timestamp: 0,
    loadAverage1m: 0,
    loadAverage5m: 0,
    loadAverage15m: 0,
    systemMemoryTotalBytes: 0,
    systemMemoryUsedBytes: 0,
    systemMemoryAvailableBytes: 0,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
    systemUptimeSeconds: 120,
    openFileDescriptors: 10,
    maxFileDescriptors: 1024,
    diskMounts: [],
    diskReadBytes: 0,
    diskWriteBytes: 0,
    networkInterfaces: [],
    localIpAddresses: ["192.168.1.20", "fd00::10"],
    publicIpAddresses: ["8.8.8.8"],
    nginxRssBytes: 0,
    errorRate4xx: 0,
    errorRate5xx: 0,
  };
}

function createNode(): NodeDetail {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "monitoring-node",
    type: "monitoring",
    hostname: "monitoring-node",
    displayName: null,
    appearanceColor: null,
    status: "offline",
    serviceCreationLocked: false,
    daemonVersion: "1.0.0",
    osInfo: "linux/amd64",
    configVersionHash: null,
    capabilities: {},
    lastSeenAt: "2026-07-18T00:00:00.000Z",
    lastHealthReport: createHealthReport(),
    lastStatsReport: null,
    liveHealthReport: null,
    liveStatsReport: null,
    metadata: {},
    isConnected: false,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
}

describe("NodeDetailsTab", () => {
  it("keeps daemon update available across a Gateway version mismatch", () => {
    const node = {
      ...createNode(),
      status: "online" as const,
      isConnected: true,
      capabilities: { versionMismatch: true },
    };
    render(
      <MemoryRouter>
        <NodeDetailsTab
          node={node}
          daemonUpdate={{ available: true, latestVersion: "2.0.0" }}
          refreshNode={vi.fn().mockResolvedValue(undefined)}
          refreshDaemonUpdateStatus={vi.fn().mockResolvedValue(undefined)}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole("button", { name: "Update to 2.0.0" })).toBeEnabled();
  });

  it("shows the last known public and local IP addresses for an offline node", async () => {
    render(
      <MemoryRouter>
        <NodeDetailsTab
          node={createNode()}
          daemonUpdate={{ available: false, latestVersion: null }}
          refreshNode={vi.fn().mockResolvedValue(undefined)}
          refreshDaemonUpdateStatus={vi.fn().mockResolvedValue(undefined)}
        />
      </MemoryRouter>
    );

    expect(screen.getByText("IP Addresses")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View 3 addresses" })).toBeInTheDocument();
    expect(screen.queryByText("192.168.1.20")).not.toBeInTheDocument();

    const identityPanel = screen.getByRole("heading", { name: "Identity" }).closest(".border");
    const systemPanel = screen
      .getByRole("heading", { name: "System Information" })
      .closest(".border");
    expect(identityPanel).not.toBeNull();
    expect(systemPanel).not.toBeNull();
    expect(
      within(identityPanel as HTMLElement).queryByText("IP Addresses")
    ).not.toBeInTheDocument();
    expect(within(systemPanel as HTMLElement).getByText("IP Addresses")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "View 3 addresses" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "IP Addresses" })).toBeInTheDocument();
    expect(
      within(dialog).getByRole("heading", { name: "Public IP Addresses" })
    ).toBeInTheDocument();
    expect(within(dialog).getByText("8.8.8.8")).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Local IP Addresses" })).toBeInTheDocument();
    expect(within(dialog).getByText("192.168.1.20")).toBeInTheDocument();
    expect(within(dialog).getByText("fd00::10")).toBeInTheDocument();
  });
});
