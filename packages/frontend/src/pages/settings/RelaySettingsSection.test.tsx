import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import { confirm } from "@/components/common/ConfirmDialog";
import { PageTransition } from "@/components/common/PageTransition";
import { api } from "@/services/api";
import type { AuthProvisioningSettings, DashboardRelaySnapshot } from "@/types";
import { RelaySettingsSection } from "./RelaySettingsSection";

vi.mock("@/components/common/ConfirmDialog", () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

function renderRelaySettings() {
  return render(
    <PageTransition>
      <RelaySettingsSection canEdit />
    </PageTransition>
  );
}

describe("RelaySettingsSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    api.invalidateCache();
    vi.mocked(confirm).mockReset().mockResolvedValue(true);
  });

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

    renderRelaySettings();

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

    renderRelaySettings();

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

  it("saves an all-ready-relays default without exposing per-link topology", async () => {
    const user = userEvent.setup();
    const current = relaySettings();
    const updated = {
      ...current,
      generalSettings: {
        ...current.generalSettings,
        relay: {
          ...current.generalSettings.relay!,
          assignmentSpread: { mode: "all" as const },
        },
      },
    };
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(current);
    vi.spyOn(api, "getRelayStatus").mockResolvedValue(null);
    const save = vi.spyOn(api, "updateAuthProvisioningSettings").mockResolvedValue(updated);

    renderRelaySettings();
    await user.click(
      await screen.findByRole("combobox", { name: "Default workload relay spread mode" })
    );
    await user.click(screen.getByRole("option", { name: "All ready relays" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        generalSettings: expect.objectContaining({
          relay: expect.objectContaining({ assignmentSpread: { mode: "all" } }),
        }),
      })
    );
  });

  it("renders the session cache immediately while refreshing in the background", () => {
    const cachedSettings = relaySettings();
    const cachedStatus = relayStatus();
    api.setCache("req:/api/admin/auth-settings", cachedSettings);
    api.setCache("req:/api/system/relay", { data: cachedStatus });
    vi.spyOn(api, "getAuthProvisioningSettings").mockImplementation(() => new Promise(() => {}));
    vi.spyOn(api, "getRelayStatus").mockImplementation(() => new Promise(() => {}));

    renderRelaySettings();

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

    renderRelaySettings();

    const transition = document.querySelector("[data-page-transition]");
    expect(transition).toHaveStyle({ visibility: "hidden" });

    await act(async () => {
      resolveSettings(relaySettings());
      resolveStatus(relayStatus());
    });

    await screen.findByText("Resident memory");
    await waitFor(() => expect(transition).toHaveStyle({ visibility: "visible" }));
  });

  it("shows pool assignments and requires confirmation before force disconnect", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(relaySettings());
    vi.spyOn(api, "getRelayStatus").mockResolvedValue({
      ...relayStatus(),
      poolId: "system",
      rebalanceAvailable: true,
      endpointCount: 2,
      worstPressurePercent: 12,
      instances: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          kind: "remote",
          nodeId: "22222222-2222-4222-8222-222222222222",
          faultDomainId: "33333333-3333-4333-8333-333333333333",
          displayName: "relay-eu-2",
          advertisedAddresses: ["10.0.0.22"],
          servicePort: 9443,
          state: "draining",
          buildVersion: "v2.7.0",
          protocolMajor: 1,
          appliedPolicyRevision: 12,
          policyExpiresAt: "2026-08-20T20:00:00.000Z",
          lastSeenAt: "2026-08-20T19:59:00.000Z",
          activeAssignments: 2,
          updateStep: { state: "verifying", error: null },
          health: { activeTunnels: 3, registeredEndpoints: 2, pressurePercent: 12 },
        },
      ],
    });
    const force = vi
      .spyOn(api, "forceDisconnectRelayInstance")
      .mockResolvedValue({ ...relayStatus(), instances: [] });

    renderRelaySettings();

    expect(await screen.findByText("relay-eu-2")).toBeInTheDocument();
    expect(screen.getByText("2 active")).toBeInTheDocument();
    expect(screen.getByText("0/1 ready")).toBeInTheDocument();
    expect(screen.getByText("1 fault domain")).toBeInTheDocument();
    expect(screen.getByText("Update: verifying")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Force disconnect" }));

    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Disconnect active streams on relay-eu-2?",
          variant: "destructive",
        })
      )
    );
    expect(force).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("keeps the local relay first and sorts remote relays by name", async () => {
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(relaySettings());
    const instance = (
      overrides: Partial<NonNullable<DashboardRelaySnapshot["instances"]>[number]>
    ) => ({
      id: "11111111-1111-4111-8111-111111111111",
      kind: "remote" as const,
      nodeId: "22222222-2222-4222-8222-222222222222",
      faultDomainId: "33333333-3333-4333-8333-333333333333",
      displayName: "relay-zebra",
      advertisedAddresses: ["10.0.0.22"],
      servicePort: 9443,
      state: "ready" as const,
      buildVersion: "v2.7.0",
      protocolMajor: 1,
      appliedPolicyRevision: 12,
      policyExpiresAt: "2099-08-20T20:00:00.000Z",
      lastSeenAt: "2026-08-20T19:59:00.000Z",
      activeAssignments: 0,
      health: { activeTunnels: 0, registeredEndpoints: 0, pressurePercent: 0 },
      ...overrides,
    });
    vi.spyOn(api, "getRelayStatus").mockResolvedValue({
      ...relayStatus(),
      instances: [
        instance({ displayName: "relay-zebra" }),
        instance({
          id: "44444444-4444-4444-8444-444444444444",
          displayName: "relay-alpha",
        }),
        instance({
          id: "00000000-0000-4000-8000-000000000001",
          kind: "local",
          nodeId: null,
          displayName: "Local relay",
          advertisedAddresses: [],
        }),
      ],
    });

    renderRelaySettings();

    await screen.findByText("relay-zebra");
    const rows = [...document.querySelectorAll("tbody tr")].map((row) => row.textContent);
    expect(rows.slice(0, 3)).toEqual([
      expect.stringContaining("Local relay"),
      expect.stringContaining("relay-alpha"),
      expect.stringContaining("relay-zebra"),
    ]);
    expect(screen.getByText("Local", { exact: true }).closest("div")).toHaveClass("bg-muted");
  });

  it("removes a fully drained and unassigned remote relay after confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(relaySettings());
    vi.spyOn(api, "getRelayStatus").mockResolvedValue({
      ...relayStatus(),
      instances: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          kind: "remote",
          nodeId: "22222222-2222-4222-8222-222222222222",
          faultDomainId: "33333333-3333-4333-8333-333333333333",
          displayName: "relay-eu-2",
          advertisedAddresses: ["10.0.0.22"],
          servicePort: 9443,
          state: "draining",
          buildVersion: "v2.7.0",
          protocolMajor: 1,
          appliedPolicyRevision: 12,
          policyExpiresAt: "2099-08-20T20:00:00.000Z",
          lastSeenAt: "2026-08-20T19:59:00.000Z",
          activeAssignments: 0,
          health: { activeTunnels: 0, registeredEndpoints: 0, pressurePercent: 0 },
        },
      ],
    });
    const remove = vi.spyOn(api, "deleteNode").mockResolvedValue();

    renderRelaySettings();
    await user.click(await screen.findByRole("button", { name: "Remove" }));

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Remove relay-eu-2?", variant: "destructive" })
    );
    expect(remove).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
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
        assignmentSpread: { mode: "fixed", count: 2 },
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
