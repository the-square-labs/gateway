import { api } from "@/services/api";
import { APP_STATUS_STORAGE_KEY, useAppStatusStore } from "@/stores/app-status";
import { useUpdateStore } from "@/stores/update";
import type { UpdateStatus } from "@/types";

vi.mock("@/services/api", () => ({
  api: {
    checkForUpdates: vi.fn(),
    getVersionInfo: vi.fn(),
    setCache: vi.fn(),
    triggerUpdate: vi.fn(),
    triggerRelayUpdate: vi.fn(),
    proceedWithUpdate: vi.fn(),
    acknowledgeUpdateFailure: vi.fn(),
    abandonRelayUpdate: vi.fn(),
  },
}));

describe("useUpdateStore", () => {
  beforeEach(() => {
    vi.mocked(api.triggerUpdate).mockReset();
    vi.mocked(api.triggerRelayUpdate).mockReset();
    vi.mocked(api.getVersionInfo).mockReset();
    vi.mocked(api.checkForUpdates).mockReset();
    vi.mocked(api.setCache).mockReset();
    vi.mocked(api.acknowledgeUpdateFailure).mockReset().mockResolvedValue({ acknowledged: false });
    vi.mocked(api.abandonRelayUpdate).mockReset();
    useUpdateStore.setState({
      status: null,
      isChecking: false,
      isUpdating: false,
      updatingComponent: null,
      updatingTargetVersion: null,
    });
    useAppStatusStore.setState({
      gatewayUpdatingActive: false,
      gatewayUpdatingTargetVersion: null,
      gatewayRestartingActive: false,
      gatewayRestartTargetUrl: null,
      gatewayUpdateError: null,
    });
  });

  it("shows a gateway update error when starting the update fails", async () => {
    vi.mocked(api.triggerUpdate).mockRejectedValueOnce(
      new Error("Gateway update artifact is not trusted")
    );

    await useUpdateStore.getState().triggerUpdate("v2.3.1");

    expect(useUpdateStore.getState().isUpdating).toBe(false);
    expect(useAppStatusStore.getState()).toMatchObject({
      gatewayUpdatingActive: false,
      gatewayUpdatingTargetVersion: null,
      gatewayUpdateError: {
        message: "Gateway update artifact is not trusted",
        targetVersion: "v2.3.1",
      },
    });
  });

  it("leaves update recovery polling to the application status gate", async () => {
    vi.mocked(api.triggerUpdate).mockResolvedValueOnce({
      status: "started",
      targetVersion: "v2.3.1",
    });

    await useUpdateStore.getState().triggerUpdate("v2.3.1");

    expect(api.triggerUpdate).toHaveBeenCalledWith("v2.3.1");
    expect(api.getVersionInfo).not.toHaveBeenCalled();
    expect(useAppStatusStore.getState()).toMatchObject({
      gatewayUpdatingActive: true,
      gatewayUpdatingTargetVersion: "v2.3.1",
    });
  });

  it("starts a relay-only update without enabling the Gateway restart gate", async () => {
    vi.mocked(api.triggerRelayUpdate).mockResolvedValueOnce({
      status: "started",
      targetVersion: "v2.6.13",
    });
    vi.mocked(api.getVersionInfo).mockResolvedValueOnce({
      currentVersion: "v2.6.12",
      latestVersion: null,
      updateAvailable: false,
      releaseNotes: null,
      releaseUrl: null,
      lastCheckedAt: null,
      relay: {
        currentVersion: "v2.6.12",
        latestVersion: "v2.6.13",
        updateAvailable: true,
        releaseNotes: null,
        releaseUrl: null,
        operation: {
          status: "updating",
          targetVersion: "v2.6.13",
          startedAt: "2026-08-16T18:00:00.000Z",
          error: null,
        },
      },
    });

    await useUpdateStore.getState().triggerRelayUpdate("v2.6.13");

    expect(api.triggerRelayUpdate).toHaveBeenCalledWith("v2.6.13");
    expect(useUpdateStore.getState()).toMatchObject({
      isUpdating: true,
      updatingComponent: "relay",
      updatingTargetVersion: "v2.6.13",
    });
    expect(useAppStatusStore.getState().gatewayUpdatingActive).toBe(false);
  });

  it("keeps the Relay update gate active when the immediate status response is stale", async () => {
    vi.mocked(api.triggerRelayUpdate).mockResolvedValueOnce({
      status: "started",
      targetVersion: "v2.6.13",
    });
    vi.mocked(api.getVersionInfo).mockResolvedValueOnce({
      currentVersion: "v2.6.12",
      latestVersion: null,
      updateAvailable: false,
      releaseNotes: null,
      releaseUrl: null,
      lastCheckedAt: null,
      relay: {
        currentVersion: "v2.6.12",
        latestVersion: "v2.6.13",
        updateAvailable: true,
        releaseNotes: null,
        releaseUrl: null,
        operation: null,
      },
    });

    await useUpdateStore.getState().triggerRelayUpdate("v2.6.13");

    expect(useUpdateStore.getState()).toMatchObject({
      isUpdating: true,
      updatingComponent: "relay",
      updatingTargetVersion: "v2.6.13",
    });
  });

  it("restores a Relay update operation from server status", async () => {
    vi.mocked(api.getVersionInfo).mockResolvedValueOnce({
      currentVersion: "v2.6.12",
      latestVersion: null,
      updateAvailable: false,
      releaseNotes: null,
      releaseUrl: null,
      lastCheckedAt: null,
      relay: {
        currentVersion: "v2.6.12",
        latestVersion: "v2.6.13",
        updateAvailable: true,
        releaseNotes: null,
        releaseUrl: null,
        operation: {
          status: "updating",
          targetVersion: "v2.6.13",
          startedAt: "2026-08-16T18:00:00.000Z",
          error: null,
        },
      },
    });

    await useUpdateStore.getState().fetchStatus();

    expect(useUpdateStore.getState()).toMatchObject({
      isUpdating: true,
      updatingComponent: "relay",
    });
  });

  it("shows the update screen in a session that missed the update event", async () => {
    vi.mocked(api.getVersionInfo).mockResolvedValueOnce({
      currentVersion: "v2.4.0",
      latestVersion: "v2.5.0",
      updateAvailable: true,
      releaseNotes: null,
      releaseUrl: null,
      lastCheckedAt: null,
      relay: {
        currentVersion: "v2.4.0",
        latestVersion: null,
        updateAvailable: false,
        releaseNotes: null,
        releaseUrl: null,
        operation: null,
      },
      gatewayOperation: {
        status: "waiting_for_operations",
        targetVersion: "v2.5.0",
        startedAt: "2026-09-23T12:00:00.000Z",
        waitDeadline: "2026-09-23T12:15:00.000Z",
        operations: [{ kind: "compose", label: "Compose operations", count: 1 }],
      },
    });

    await useUpdateStore.getState().fetchStatus();

    expect(useAppStatusStore.getState()).toMatchObject({
      gatewayUpdatingActive: true,
      gatewayUpdatingTargetVersion: "v2.5.0",
    });
  });

  describe("after a rolled-back update", () => {
    const rolledBack: UpdateStatus = {
      currentVersion: "v2.4.0",
      latestVersion: "v2.5.0",
      updateAvailable: true,
      releaseNotes: null,
      releaseUrl: null,
      lastCheckedAt: null,
      relay: {
        currentVersion: "v2.4.0",
        latestVersion: null,
        updateAvailable: false,
        releaseNotes: null,
        releaseUrl: null,
        operation: null,
      },
      gatewayOperation: {
        status: "failed",
        targetVersion: "v2.5.0",
        startedAt: "2026-09-23T12:00:00.000Z",
        waitDeadline: null,
        operations: [],
        error: "Gateway v2.5.0 did not start, so the update was rolled back.",
      },
    };

    it("replaces the update screen with the server's error and clears the persisted state", async () => {
      useAppStatusStore.getState().setGatewayUpdatingActive(true, "v2.5.0");
      useUpdateStore.setState({ isUpdating: true, updatingComponent: "gateway" });
      vi.mocked(api.getVersionInfo).mockResolvedValueOnce(rolledBack);

      await expect(useUpdateStore.getState().fetchStatus()).resolves.toEqual(rolledBack);

      expect(useAppStatusStore.getState()).toMatchObject({
        gatewayUpdatingActive: false,
        gatewayUpdatingTargetVersion: null,
        gatewayUpdatingStartedAt: null,
        gatewayUpdateError: {
          message: "Gateway v2.5.0 did not start, so the update was rolled back.",
          targetVersion: "v2.5.0",
          rolledBack: true,
        },
      });
      expect(useUpdateStore.getState().isUpdating).toBe(false);
      const persisted = JSON.parse(window.localStorage.getItem(APP_STATUS_STORAGE_KEY) ?? "{}");
      expect(persisted.state).toMatchObject({
        gatewayUpdatingActive: false,
        gatewayUpdatingTargetVersion: null,
      });
    });

    it("never locks a session that was not waiting for the update", async () => {
      vi.mocked(api.getVersionInfo).mockResolvedValueOnce(rolledBack);

      await useUpdateStore.getState().fetchStatus();

      expect(useAppStatusStore.getState()).toMatchObject({
        gatewayUpdatingActive: false,
        gatewayUpdateError: null,
      });
    });

    it("clears the old report before a new attempt shows the update screen", async () => {
      const order: string[] = [];
      vi.mocked(api.acknowledgeUpdateFailure).mockImplementationOnce(async () => {
        order.push(`acknowledge:${useAppStatusStore.getState().gatewayUpdatingActive}`);
        return { acknowledged: true };
      });
      vi.mocked(api.triggerUpdate).mockImplementationOnce(async () => {
        order.push("trigger");
        return { status: "updating", targetVersion: "v2.5.0" };
      });

      await useUpdateStore.getState().triggerUpdate("v2.5.0");

      expect(order).toEqual(["acknowledge:false", "trigger"]);
      expect(useAppStatusStore.getState().gatewayUpdatingActive).toBe(true);
    });
  });

  it("abandons a stuck Relay update and leaves the Relay update screen", async () => {
    useUpdateStore.setState({
      isUpdating: true,
      updatingComponent: "relay",
      updatingTargetVersion: "v2.6.13",
    });
    vi.mocked(api.abandonRelayUpdate).mockResolvedValueOnce({ targetVersion: "v2.6.13" });
    vi.mocked(api.getVersionInfo).mockRejectedValueOnce(new Error("offline"));

    await useUpdateStore.getState().abandonRelayUpdate();

    expect(api.abandonRelayUpdate).toHaveBeenCalledOnce();
    expect(useUpdateStore.getState()).toMatchObject({ isUpdating: false, updatingComponent: null });
  });

  it("asks the server to update now and refreshes the update status", async () => {
    vi.mocked(api.proceedWithUpdate).mockResolvedValueOnce({ status: "updating" });
    vi.mocked(api.getVersionInfo).mockRejectedValueOnce(new Error("offline"));

    await useUpdateStore.getState().proceedWithUpdate();

    expect(api.proceedWithUpdate).toHaveBeenCalledOnce();
    expect(api.getVersionInfo).toHaveBeenCalledOnce();
  });
});
