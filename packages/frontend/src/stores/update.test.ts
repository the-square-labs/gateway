import { api } from "@/services/api";
import { useAppStatusStore } from "@/stores/app-status";
import { useUpdateStore } from "@/stores/update";

vi.mock("@/services/api", () => ({
  api: {
    checkForUpdates: vi.fn(),
    getVersionInfo: vi.fn(),
    setCache: vi.fn(),
    triggerUpdate: vi.fn(),
    triggerRelayUpdate: vi.fn(),
  },
}));

describe("useUpdateStore", () => {
  beforeEach(() => {
    vi.mocked(api.triggerUpdate).mockReset();
    vi.mocked(api.triggerRelayUpdate).mockReset();
    vi.mocked(api.getVersionInfo).mockReset();
    vi.mocked(api.checkForUpdates).mockReset();
    vi.mocked(api.setCache).mockReset();
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
});
