import { api } from "@/services/api";
import { useAppStatusStore } from "@/stores/app-status";
import { useUpdateStore } from "@/stores/update";

vi.mock("@/services/api", () => ({
  api: {
    checkForUpdates: vi.fn(),
    getVersionInfo: vi.fn(),
    setCache: vi.fn(),
    triggerUpdate: vi.fn(),
  },
}));

describe("useUpdateStore", () => {
  beforeEach(() => {
    vi.mocked(api.triggerUpdate).mockReset();
    vi.mocked(api.getVersionInfo).mockReset();
    vi.mocked(api.checkForUpdates).mockReset();
    vi.mocked(api.setCache).mockReset();
    useUpdateStore.setState({
      status: null,
      isChecking: false,
      isUpdating: false,
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
});
