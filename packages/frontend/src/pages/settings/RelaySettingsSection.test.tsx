import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, vi } from "vitest";
import { confirm } from "@/components/common/ConfirmDialog";
import { PageTransition } from "@/components/common/PageTransition";
import { buttonVariants } from "@/components/ui/button";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
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

  it.each([
    "active",
    "failed",
    "staging",
  ] as const)("reports the actual %s rebalance result before the status refresh", async (state) => {
    const user = userEvent.setup();
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(relaySettings());
    const status = { ...relayStatus(), poolId: "system", rebalanceAvailable: true, instances: [] };
    let finishRefresh!: (value: DashboardRelaySnapshot) => void;
    vi.spyOn(api, "getRelayStatus")
      .mockResolvedValueOnce(status)
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          })
      );
    vi.spyOn(api, "rebalanceRelayPool").mockResolvedValue([
      {
        id: "new",
        state,
        error: state === "failed" ? "Pool candidate grant is unavailable" : null,
      },
    ]);
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const info = vi.spyOn(toast, "info");
    renderRelaySettings();
    await user.click(await screen.findByRole("button", { name: "Rebalance" }));
    await waitFor(() => {
      if (state === "active") expect(success).toHaveBeenCalledWith("Relay rebalance activated");
      if (state === "failed")
        expect(error).toHaveBeenCalledWith("Relay rebalance failed for 1 workload", {
          description: "Pool candidate grant is unavailable",
        });
      if (state === "staging")
        expect(info).toHaveBeenCalledWith("Relay rebalance is still verifying routes");
    });
    if (state !== "active") expect(success).not.toHaveBeenCalled();
    await act(async () => {
      finishRefresh(status);
    });
  });

  it("does not report a successful rebalance as failed when the follow-up read fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(relaySettings());
    vi.spyOn(api, "getRelayStatus")
      .mockResolvedValueOnce({
        ...relayStatus(),
        poolId: "system",
        rebalanceAvailable: true,
        instances: [],
      })
      .mockRejectedValue(new Error("refresh timeout"));
    vi.spyOn(api, "rebalanceRelayPool").mockResolvedValue([
      { id: "new", state: "active", error: null },
    ]);
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const warning = vi.spyOn(toast, "warning");
    renderRelaySettings();
    await user.click(await screen.findByRole("button", { name: "Rebalance" }));
    await waitFor(() => expect(warning).toHaveBeenCalled());
    expect(success).toHaveBeenCalledWith("Relay rebalance activated");
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps failed generations and incompatible relay reasons visible after reload", async () => {
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(relaySettings());
    vi.spyOn(api, "getRelayStatus").mockResolvedValue({
      ...relayStatus(),
      poolId: "system",
      rebalanceAvailable: true,
      instances: [],
      blockers: ["Local relay: Relay Pool capability is unavailable"],
      attempts: [
        {
          id: "new",
          endpointId: "endpoint",
          generation: 2,
          workload: "notes.example.com",
          state: "failed",
          createdAt: "2026-09-11T00:00:00Z",
          activationError: "Pool candidate grant is unavailable",
          updatedAt: "2026-09-11T00:00:00Z",
        },
      ],
    });
    renderRelaySettings();
    expect(
      await screen.findByText(/Local relay: Relay Pool capability is unavailable/)
    ).toBeInTheDocument();
    expect(screen.getByText("Pool candidate grant is unavailable")).toBeInTheDocument();
    expect(screen.getByText("notes.example.com")).toBeInTheDocument();
    expect(screen.getByText("Rebalance attempts")).toBeInTheDocument();
    expect(
      screen.getByText("Pool candidate grant is unavailable").closest('[role="alert"]')
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Rebalance" })).toBeDisabled();
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
    expect(screen.getByRole("button", { name: "Force disconnect" }).className).toBe(
      buttonVariants({ variant: "destructive" })
    );
    expect(screen.getByRole("button", { name: "Resume" }).className).toBe(
      buttonVariants({ variant: "outline" })
    );
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

  it("lets an admin abandon a paused Relay Pool update after confirming", async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      user: { id: "admin-1", scopes: ["admin:update"] } as never,
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(relaySettings());
    const paused = {
      ...relayStatus(),
      poolId: "system",
      instances: [],
      update: { state: "paused", targetVersion: "v2.4.3", error: "relay-2 failed verification" },
    };
    vi.spyOn(api, "getRelayStatus")
      .mockResolvedValueOnce(paused)
      .mockResolvedValue({ ...paused, update: { ...paused.update, state: "failed" } });
    const abandon = vi
      .spyOn(api, "abandonRelayUpdate")
      .mockResolvedValue({ targetVersion: "v2.4.3" });
    vi.spyOn(api, "getVersionInfo").mockRejectedValue(new Error("offline"));
    vi.mocked(confirm).mockResolvedValueOnce(false);

    renderRelaySettings();
    const button = await screen.findByRole("button", { name: "Abandon update" });
    await user.click(button);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Abandon Relay Pool update?", variant: "destructive" })
    );
    expect(abandon).not.toHaveBeenCalled();

    await user.click(button);
    await waitFor(() => expect(abandon).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Abandon update" })).not.toBeInTheDocument()
    );
    useAuthStore.setState({ user: null, isAuthenticated: false });
  });

  it("hides the abandon action from users without admin:update", async () => {
    useAuthStore.setState({
      user: { id: "user-1", scopes: ["settings:gateway:edit"] } as never,
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(relaySettings());
    vi.spyOn(api, "getRelayStatus").mockResolvedValue({
      ...relayStatus(),
      poolId: "system",
      instances: [],
      update: { state: "paused", targetVersion: "v2.4.3", error: null },
    });

    renderRelaySettings();
    expect(await screen.findByText(/Pool update to v2.4.3: paused/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abandon update" })).not.toBeInTheDocument();
    useAuthStore.setState({ user: null, isAuthenticated: false });
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

  it.each([
    { state: "draining" as const, retainedAssignments: 0, activeTunnels: 0, removable: true },
    { state: "draining" as const, retainedAssignments: 3, activeTunnels: 0, removable: false },
    { state: "offline" as const, retainedAssignments: 12, activeTunnels: 99, removable: true },
  ])("handles removal of $state relay with $retainedAssignments retained assignments", async ({
    state,
    retainedAssignments,
    activeTunnels,
    removable,
  }) => {
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
          state,
          buildVersion: "v2.7.0",
          protocolMajor: 1,
          appliedPolicyRevision: 12,
          policyExpiresAt: "2099-08-20T20:00:00.000Z",
          lastSeenAt: "2026-08-20T19:59:00.000Z",
          activeAssignments: 0,
          retainedAssignments,
          health: { activeTunnels, registeredEndpoints: 0, pressurePercent: 0 },
        },
      ],
    });
    const remove = vi.spyOn(api, "deleteNode").mockResolvedValue();

    renderRelaySettings();
    if (!removable) {
      expect(await screen.findByText("3 staging / draining")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
      expect(remove).not.toHaveBeenCalled();
      return;
    }
    const removeButton = await screen.findByRole("button", { name: "Remove" });
    expect(removeButton.className).toBe(buttonVariants({ variant: "destructive" }));
    await user.click(removeButton);

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Remove relay-eu-2?", variant: "destructive" })
    );
    if (state === "offline") {
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expect.stringContaining(
            "every affected workload has a ready remaining relay"
          ),
        })
      );
    }
    expect(remove).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
  });

  it("explains a remote trust lockout and hands out a re-enrollment command", async () => {
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
          advertisedAddresses: ["relay.example.test"],
          servicePort: 9443,
          state: "synchronizing",
          buildVersion: "v2.7.0",
          protocolMajor: 1,
          appliedPolicyRevision: 12,
          policyExpiresAt: "2026-08-20T20:00:00.000Z",
          lastSeenAt: "2026-08-20T19:59:00.000Z",
          activeAssignments: 0,
          health: { activeTunnels: 0, registeredEndpoints: 0, pressurePercent: 0 },
          policyTrust: {
            state: "reenrollment_required",
            message: "This relay trusts only policy signing keys Gateway can no longer sign with.",
            observedAt: "2026-09-24T10:00:00.000Z",
            trustedKeyIds: ["destroyed"],
          },
        },
      ],
    });
    const reenroll = vi.spyOn(api, "reenrollRelayInstance").mockResolvedValue({
      instanceId: "11111111-1111-4111-8111-111111111111",
      nodeId: "22222222-2222-4222-8222-222222222222",
      displayName: "relay-eu-2",
      enrollmentToken: `gw_node_v2_${"a".repeat(16)}_${"b".repeat(48)}`,
      enrollmentTokenExpiresAt: "2026-10-01T10:00:00.000Z",
      advertiseAddress: "relay.example.test",
      servicePort: 9443,
      gatewayCertSha256: `sha256:${"c".repeat(64)}`,
      gatewayEnrollmentTargets: {
        public: { label: "Public node", gateway: "gateway.example.test:9443" },
      },
    });

    renderRelaySettings();

    expect(
      await screen.findByText(/trusts only policy signing keys Gateway can no longer sign with/)
    ).toHaveAttribute("role", "alert");
    await user.click(screen.getByRole("button", { name: "Re-enroll" }));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Re-enroll relay-eu-2?" })
    );
    expect(reenroll).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText(/setup-relay-node\.sh/).length).toBeGreaterThan(0);
    expect(
      within(dialog).getAllByText(/--advertise-address relay\.example\.test/).length
    ).toBeGreaterThan(0);
    expect(
      within(dialog).getAllByText(/--gateway gateway\.example\.test:9443/).length
    ).toBeGreaterThan(0);
  });

  it("does not offer re-enrollment for a healthy relay or the local relay", async () => {
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
          state: "ready",
          buildVersion: "v2.7.0",
          protocolMajor: 1,
          appliedPolicyRevision: 12,
          policyExpiresAt: "2099-08-20T20:00:00.000Z",
          lastSeenAt: "2026-08-20T19:59:00.000Z",
          activeAssignments: 0,
          health: { activeTunnels: 0, registeredEndpoints: 0, pressurePercent: 0 },
        },
        {
          id: "00000000-0000-4000-8000-000000000001",
          kind: "local",
          nodeId: null,
          faultDomainId: "44444444-4444-4444-8444-444444444444",
          displayName: "Local relay",
          advertisedAddresses: [],
          servicePort: 9443,
          state: "synchronizing",
          buildVersion: "v2.7.0",
          protocolMajor: 1,
          appliedPolicyRevision: 12,
          policyExpiresAt: null,
          lastSeenAt: null,
          activeAssignments: 0,
          health: { activeTunnels: 0, registeredEndpoints: 0, pressurePercent: 0 },
          policyTrust: {
            state: "recovery_unsupported",
            message:
              "The local relay trusts only policy signing keys Gateway can no longer sign with. Update the Relay Pool.",
            observedAt: "2026-09-24T10:00:00.000Z",
            trustedKeyIds: ["destroyed"],
          },
        },
      ],
    });

    renderRelaySettings();

    expect(await screen.findByText(/Update the Relay Pool\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Re-enroll" })).not.toBeInTheDocument();
  });

  it("shows an expired relay certificate and renews it on request", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(relaySettings());
    const relay = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "remote" as const,
      nodeId: "22222222-2222-4222-8222-222222222222",
      faultDomainId: "33333333-3333-4333-8333-333333333333",
      displayName: "relay-eu-2",
      advertisedAddresses: ["relay.example.test"],
      servicePort: 9443,
      state: "ready" as const,
      buildVersion: "v2.7.0",
      protocolMajor: 1,
      appliedPolicyRevision: 12,
      policyExpiresAt: "2099-08-20T20:00:00.000Z",
      lastSeenAt: "2026-08-20T19:59:00.000Z",
      activeAssignments: 0,
      health: { activeTunnels: 0, registeredEndpoints: 0, pressurePercent: 0 },
      certificate: {
        state: "expired" as const,
        message:
          "The relay certificate expired on 2026-09-01. If the supervisor cannot reconnect, re-enroll the relay.",
        expiresAt: "2026-09-01T00:00:00.000Z",
        observedAt: "2026-09-24T10:00:00.000Z",
      },
    };
    vi.spyOn(api, "getRelayStatus").mockResolvedValue({ ...relayStatus(), instances: [relay] });
    const renew = vi
      .spyOn(api, "renewRelayInstanceCertificate")
      .mockResolvedValue({ ...relayStatus(), instances: [{ ...relay, certificate: null }] });

    renderRelaySettings();

    expect(await screen.findByText(/The relay certificate expired on 2026-09-01/)).toHaveAttribute(
      "role",
      "alert"
    );
    // An expired certificate can also be repaired by re-enrolling the relay.
    expect(screen.getByRole("button", { name: "Re-enroll" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Renew certificate" }));
    expect(renew).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    await waitFor(() =>
      expect(screen.queryByText(/The relay certificate expired/)).not.toBeInTheDocument()
    );
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
