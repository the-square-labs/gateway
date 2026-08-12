import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import { api } from "@/services/api";
import type { AuthProvisioningSettings, DashboardRelaySnapshot } from "@/types";
import { RelaySettingsSection } from "./RelaySettingsSection";

describe("RelaySettingsSection", () => {
  beforeEach(() => api.invalidateCache());

  it("renders relay-owned telemetry as metric cards without a last-probe header", async () => {
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue({
      generalSettings: {
        relayAutoRecovery: true,
        relayGrantTtlHours: 4,
        relay: {
          dataLanes: 4,
          readChunkBytes: 32 * 1024,
          adaptiveAdmissionEnabled: true,
          proxyTargetPressurePercent: 70,
          databaseReservePercent: 20,
          hardPressurePercent: 95,
        },
      },
    } as never);
    vi.spyOn(api, "getRelayStatus").mockResolvedValue({
      state: "healthy",
      impact: null,
      attempt: 0,
      maxAttempts: 3,
      lastHealthyAt: "2026-08-11T20:00:00.000Z",
      lastProbeAt: "2026-08-11T20:00:00.000Z",
      relayBuildVersion: "relay-r4",
      protocolMajor: 1,
      admissionState: "normal",
      pressurePercent: 1,
      cpuPressurePercent: 1,
      memoryPressurePercent: 0,
      fdPressurePercent: 0,
      memoryRssBytes: 18 * 1024 * 1024,
      heapInUseBytes: 6 * 1024 * 1024,
      memoryLimitBytes: 0,
      openFileDescriptors: 42,
      fileDescriptorLimit: 1_048_576,
      registeredEndpoints: 7,
      activeTunnels: 5,
      activeProxyTunnels: 0,
      activeDatabaseTunnels: 5,
      throttledProxyTotal: 0,
      throttledDatabaseTotal: 0,
    });

    render(<RelaySettingsSection canEdit />);

    expect(await screen.findByText("Resident memory")).toBeInTheDocument();
    expect(screen.getByText("18.0 MB")).toBeInTheDocument();
    expect(screen.getByText("6.0 MB heap · no cgroup limit")).toBeInTheDocument();
    expect(screen.getByText("File descriptors")).toBeInTheDocument();
    expect(screen.getAllByText("No throttling")).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/undefined|NaN/);
    expect(screen.queryByText(/Last probe/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Memory 30%/i)).not.toBeInTheDocument();
  });

  it("marks relay settings dirty and enables Save only after a change", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue({
      generalSettings: {
        relayAutoRecovery: true,
        relayGrantTtlHours: 4,
        relay: {
          dataLanes: 4,
          readChunkBytes: 32 * 1024,
          adaptiveAdmissionEnabled: true,
          proxyTargetPressurePercent: 70,
          databaseReservePercent: 20,
          hardPressurePercent: 95,
        },
      },
    } as never);
    vi.spyOn(api, "getRelayStatus").mockResolvedValue(null as never);

    render(<RelaySettingsSection canEdit />);

    const saveButton = await screen.findByRole("button", { name: "Save" });
    const panel = screen.getByText("Relay runtime").closest("div.border") as HTMLElement;
    const dataLanesCard = screen
      .getByText("Persistent HTTP/2 lanes per daemon")
      .closest("div.border") as HTMLElement;
    const readBufferCard = screen
      .getByText("Pooled per-stream read chunk")
      .closest("div.border") as HTMLElement;
    expect(saveButton).toBeDisabled();
    expect(saveButton.querySelector("svg")).not.toBeNull();
    expect(within(dataLanesCard).getByText("4")).toBeInTheDocument();
    expect(within(readBufferCard).getByText("32 KiB")).toBeInTheDocument();

    const [dataLanesInput, readBufferInput] = within(panel).getAllByRole("spinbutton");
    await user.clear(dataLanesInput);
    await user.type(dataLanesInput, "5");
    await user.clear(readBufferInput!);
    await user.type(readBufferInput!, "65536");

    expect(saveButton).toBeEnabled();
    expect(panel).toHaveStyle({ borderColor: "var(--color-warning)" });
    expect(within(dataLanesCard).getByText("4")).toBeInTheDocument();
    expect(within(readBufferCard).getByText("32 KiB")).toBeInTheDocument();
  });

  it("renders the session cache immediately while refreshing in the background", () => {
    const cachedSettings = relaySettings();
    const cachedStatus = relayStatus();
    api.setCache("req:/api/admin/auth-settings", cachedSettings);
    api.setCache("req:/api/system/relay", { data: cachedStatus });
    vi.spyOn(api, "getAuthProvisioningSettings").mockImplementation(() => new Promise(() => {}));
    vi.spyOn(api, "getRelayStatus").mockImplementation(() => new Promise(() => {}));

    render(<RelaySettingsSection canEdit />);

    expect(screen.getByText("Resident memory")).toBeInTheDocument();
    expect(screen.getByText("18.0 MB")).toBeInTheDocument();
    expect(document.querySelector("[data-page-transition]")).toHaveStyle({
      visibility: "visible",
    });
    expect(api.getAuthProvisioningSettings).toHaveBeenCalledTimes(1);
    expect(api.getRelayStatus).toHaveBeenCalledTimes(1);
  });

  it("waits for an uncached relay snapshot before revealing the section", async () => {
    let resolveSettings!: (value: AuthProvisioningSettings) => void;
    let resolveStatus!: (value: DashboardRelaySnapshot) => void;
    vi.spyOn(api, "getAuthProvisioningSettings").mockImplementation(
      () => new Promise((resolve) => (resolveSettings = resolve))
    );
    vi.spyOn(api, "getRelayStatus").mockImplementation(
      () => new Promise((resolve) => (resolveStatus = resolve))
    );

    render(<RelaySettingsSection canEdit />);

    const transition = document.querySelector("[data-page-transition]");
    expect(transition).toHaveStyle({ visibility: "hidden" });

    await act(async () => {
      resolveSettings(relaySettings());
      resolveStatus(relayStatus());
    });

    await screen.findByText("Resident memory");
    await waitFor(() => expect(transition).toHaveStyle({ visibility: "visible" }));
  });
});

function relaySettings(): AuthProvisioningSettings {
  return {
    generalSettings: {
      relayAutoRecovery: true,
      relayGrantTtlHours: 4,
      relay: {
        dataLanes: 4,
        readChunkBytes: 32 * 1024,
        adaptiveAdmissionEnabled: true,
        proxyTargetPressurePercent: 70,
        databaseReservePercent: 20,
        hardPressurePercent: 95,
      },
    },
  } as AuthProvisioningSettings;
}

function relayStatus(): DashboardRelaySnapshot {
  return {
    state: "healthy",
    impact: null,
    attempt: 0,
    maxAttempts: 3,
    lastHealthyAt: "2026-08-11T20:00:00.000Z",
    lastProbeAt: "2026-08-11T20:00:00.000Z",
    relayBuildVersion: "relay-r4",
    protocolMajor: 1,
    admissionState: "normal",
    pressurePercent: 1,
    cpuPressurePercent: 1,
    memoryPressurePercent: 0,
    fdPressurePercent: 0,
    memoryRssBytes: 18 * 1024 * 1024,
    heapInUseBytes: 6 * 1024 * 1024,
    memoryLimitBytes: 0,
    openFileDescriptors: 42,
    fileDescriptorLimit: 1_048_576,
    registeredEndpoints: 7,
    activeTunnels: 5,
    activeProxyTunnels: 0,
    activeDatabaseTunnels: 5,
    throttledProxyTotal: 0,
    throttledDatabaseTotal: 0,
  };
}
