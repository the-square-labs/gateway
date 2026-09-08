import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import type { NodeDetail, NodeHealthReport } from "@/types";
import type { HostingNodeProjection } from "@/types/hosting";
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
  it.each([
    "digitalocean",
    "hetzner",
    "hostkey",
    "proxmox",
  ] as const)("hides recovery and shows ownership only for Proxmox (%s)", (provider) => {
    render(
      <MemoryRouter>
        <NodeDetailsTab
          node={createNode()}
          hosting={
            {
              provider,
              kind: "vm",
              resourceId: "vm",
              origin: "created",
              powerState: "stopped",
              observedAt: "2026-09-08T00:00:00Z",
            } as HostingNodeProjection
          }
          canManageSecureRuntime={false}
          daemonUpdate={{ available: false, latestVersion: null }}
          refreshNode={vi.fn()}
          refreshDaemonUpdateStatus={vi.fn()}
        />
      </MemoryRouter>
    );
    const panel = screen
      .getByRole("heading", { name: "Hosting" })
      .closest(".bg-card")! as HTMLElement;
    expect(within(panel).queryByText("Recovery")).not.toBeInTheDocument();
    if (provider === "proxmox") expect(within(panel).getByText("Ownership")).toBeInTheDocument();
    else expect(within(panel).queryByText("Ownership")).not.toBeInTheDocument();
    expect(within(panel).getByText("Provider")).toBeInTheDocument();
    expect(within(panel).getByText("Resources")).toBeInTheDocument();
  });
  it("keeps the large container status summary alongside the new resource links without a second fetch", async () => {
    const node = { ...createNode(), type: "docker" as const };
    useAuthStore.setState({ user: makeUser({ scopes: ["docker:containers:view"] }) });
    const list = vi
      .spyOn(api, "listDockerContainerSnapshots")
      .mockResolvedValue([
        { state: "running" },
        { state: "running" },
        { state: "exited" },
        { state: "stopped" },
        { state: "paused" },
      ] as never);
    const legacyList = vi.spyOn(api, "listDockerContainers");
    render(
      <MemoryRouter>
        <NodeDetailsTab
          node={node}
          canManageSecureRuntime={false}
          daemonUpdate={{ available: false, latestVersion: null }}
          refreshNode={vi.fn()}
          refreshDaemonUpdateStatus={vi.fn()}
        />
      </MemoryRouter>
    );
    await screen.findByText("5 containers");
    const summary = screen.getByRole("region", { name: "Container summary" });
    for (const [label, value] of [
      ["Running", "2"],
      ["Stopped", "2"],
      ["Paused", "1"],
      ["Total", "5"],
    ]) {
      const cell = within(summary).getByText(label).parentElement!;
      expect(within(cell).getByText(value)).toHaveClass("text-2xl", "font-bold");
    }
    expect(screen.getByRole("link", { name: "View containers" })).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(1);
    expect(legacyList).not.toHaveBeenCalled();
  });
  it.each([
    false,
    true,
  ])("uses the shared Docker summary with five filtered links (hosting=%s)", async (withHosting) => {
    const node = { ...createNode(), type: "docker" as const };
    useAuthStore.setState({
      user: makeUser({
        scopes: ["containers", "images", "volumes", "networks", "compose"].map(
          (tab) => `docker:${tab}:view`
        ),
      }),
    });
    const containerList = vi
      .spyOn(api, "listDockerContainerSnapshots")
      .mockResolvedValue([{ _listTotal: 42 }] as never);
    vi.spyOn(api, "listDockerImageSnapshots").mockResolvedValue([{}, {}] as never);
    vi.spyOn(api, "listDockerVolumeSnapshots").mockResolvedValue([]);
    vi.spyOn(api, "listDockerNetworkSnapshots").mockResolvedValue([{}] as never);
    vi.spyOn(api, "listDockerComposeProjects").mockResolvedValue([{}, {}, {}] as never);
    render(
      <MemoryRouter>
        <NodeDetailsTab
          node={node}
          hosting={
            withHosting
              ? ({
                  provider: "proxmox",
                  kind: "vm",
                  resourceId: "vm",
                  observedAt: "2026-09-07T00:00:00Z",
                } as HostingNodeProjection)
              : null
          }
          canManageSecureRuntime={false}
          daemonUpdate={{ available: false, latestVersion: null }}
          refreshNode={vi.fn()}
          refreshDaemonUpdateStatus={vi.fn()}
        />
      </MemoryRouter>
    );
    await screen.findByText("42 containers");
    expect(containerList).toHaveBeenCalledWith({ nodeId: node.id });
    for (const label of ["2 images", "0 volumes", "1 networks", "3 compose projects"])
      expect(screen.getByText(label)).toBeInTheDocument();
    for (const tab of ["containers", "images", "volumes", "networks", "compose"]) {
      const link = screen.getByRole("link", {
        name: `View ${tab === "compose" ? "compose projects" : tab}`,
      });
      expect(link).toHaveAttribute("href", `/docker/${tab}?nodeId=${node.id}&filters=1`);
      expect(link).toHaveAttribute("data-button");
      expect(link.querySelector("svg")).toBeInTheDocument();
    }
    const panel = screen.getByRole("heading", { name: "Docker" }).closest(".bg-card")!;
    expect(panel.parentElement).toHaveClass("grid", "grid-cols-1");
    if (withHosting) {
      expect(panel.parentElement).toHaveClass("min-[1044px]:grid-cols-2");
      expect(panel.parentElement).toContainElement(
        screen.getByRole("heading", { name: "Hosting" })
      );
    } else expect(panel.parentElement).not.toHaveClass("min-[1044px]:grid-cols-2");
  });

  it("does not fetch counts or expose links for unrelated node scopes", async () => {
    const node = { ...createNode(), type: "docker" as const };
    useAuthStore.setState({
      user: makeUser({
        scopes: [
          "docker:containers:view:another-node/container",
          `docker:images:view:${node.id}/image`,
        ],
      }),
    });
    const containers = vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([]);
    const images = vi.spyOn(api, "listDockerImageSnapshots").mockResolvedValue([]);
    render(
      <MemoryRouter>
        <NodeDetailsTab
          node={node}
          canManageSecureRuntime={false}
          daemonUpdate={{ available: false, latestVersion: null }}
          refreshNode={vi.fn()}
          refreshDaemonUpdateStatus={vi.fn()}
        />
      </MemoryRouter>
    );
    await waitFor(() => expect(images).toHaveBeenCalledWith({ nodeId: node.id }));
    expect(containers).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "View containers" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View images" })).toBeInTheDocument();
  });
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
          canManageSecureRuntime={false}
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
          canManageSecureRuntime={false}
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
    expect(identityPanel?.parentElement).toHaveClass("min-[1044px]:grid-cols-2");
    expect(systemPanel?.parentElement?.parentElement).toHaveClass("min-[1044px]:grid-cols-2");
    expect(within(identityPanel as HTMLElement).getByText("IP Addresses")).toBeInTheDocument();
    expect(within(systemPanel as HTMLElement).queryByText("IP Addresses")).not.toBeInTheDocument();

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

  it("shows the existing Setup action when runsc is installable", () => {
    const node = {
      ...createNode(),
      type: "docker" as const,
      status: "online" as const,
      isConnected: true,
      capabilities: {
        dockerRuntimeStatus: {
          state: "installable",
          checkedAt: "2026-08-16T00:00:00.000Z",
          remoteInstallable: true,
          message: "Ready to install",
        },
      },
    };
    render(
      <MemoryRouter>
        <NodeDetailsTab
          node={node}
          canManageSecureRuntime
          daemonUpdate={{ available: false, latestVersion: null }}
          refreshNode={vi.fn().mockResolvedValue(undefined)}
          refreshDaemonUpdateStatus={vi.fn().mockResolvedValue(undefined)}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { name: "Secure Runtime Setup" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Setup" })).toBeEnabled();
  });

  it("hides Secure Runtime management actions without admin:update", () => {
    const node = {
      ...createNode(),
      type: "docker" as const,
      status: "online" as const,
      isConnected: true,
      capabilities: {
        dockerRuntimeStatus: {
          state: "installable",
          checkedAt: "2026-08-16T00:00:00.000Z",
          remoteInstallable: true,
          message: "Ready to install",
        },
      },
    };
    render(
      <MemoryRouter>
        <NodeDetailsTab
          node={node}
          canManageSecureRuntime={false}
          daemonUpdate={{ available: false, latestVersion: null }}
          refreshNode={vi.fn().mockResolvedValue(undefined)}
          refreshDaemonUpdateStatus={vi.fn().mockResolvedValue(undefined)}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { name: "Secure Runtime Setup" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Setup" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check compatibility" })).not.toBeInTheDocument();
  });

  it("restores an in-progress setup from node state and keeps refreshing it", async () => {
    vi.useFakeTimers();
    const refreshNode = vi.fn().mockResolvedValue(undefined);
    const node = {
      ...createNode(),
      type: "docker" as const,
      status: "offline" as const,
      isConnected: false,
      capabilities: {
        dockerRuntimeStatus: {
          state: "installing",
          targetVersion: "release-test",
          checkedAt: "2026-08-16T00:00:00.000Z",
          remoteInstallable: true,
          message: "Downloading gVisor",
          step: "downloading",
          progressPercent: 45,
        },
      },
    };
    const view = render(
      <MemoryRouter>
        <NodeDetailsTab
          node={node}
          canManageSecureRuntime
          daemonUpdate={{ available: false, latestVersion: null }}
          refreshNode={refreshNode}
          refreshDaemonUpdateStatus={vi.fn().mockResolvedValue(undefined)}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole("button", { name: "Setting up..." })).toBeDisabled();
    expect(screen.getAllByText("installing")).not.toHaveLength(0);
    expect(screen.getByText("Installing and verifying Secure Runtime")).toBeInTheDocument();
    expect(screen.getByText("Downloading gVisor")).toBeInTheDocument();
    expect(screen.getByText("45%")).toBeInTheDocument();
    expect(screen.getByLabelText("gVisor download progress").firstElementChild).toHaveStyle({
      width: "45%",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(refreshNode).toHaveBeenCalled();

    view.unmount();
    vi.useRealTimers();
  });

  it("keeps the healthy Secure Runtime status visible after setup", () => {
    const node = {
      ...createNode(),
      type: "docker" as const,
      capabilities: {
        dockerRuntimeStatus: {
          state: "healthy",
          installedVersion: "release-20260810.0",
          checkedAt: "2026-08-16T00:00:00.000Z",
          remoteInstallable: true,
          message: "runsc completed a Docker smoke test",
        },
      },
    };
    render(
      <MemoryRouter>
        <NodeDetailsTab
          node={node}
          canManageSecureRuntime={false}
          daemonUpdate={{ available: false, latestVersion: null }}
          refreshNode={vi.fn().mockResolvedValue(undefined)}
          refreshDaemonUpdateStatus={vi.fn().mockResolvedValue(undefined)}
        />
      </MemoryRouter>
    );

    expect(screen.queryByRole("heading", { name: "Secure Runtime Setup" })).not.toBeInTheDocument();
    expect(screen.getByText("Secure Runtime")).toBeInTheDocument();
    expect(screen.getByText("healthy")).toBeInTheDocument();
    expect(screen.getByText("release-20260810.0")).toBeInTheDocument();
  });
});
