import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { confirm } from "@/components/common/ConfirmDialog";
import { UpdateSection } from "@/pages/settings/UpdateSection";
import { api } from "@/services/api";
import { useUpdateStore } from "@/stores/update";
import type { UpdateStatus } from "@/types";

vi.mock("@/components/common/ConfirmDialog", () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/dev-force-updates", () => ({
  isDevForceUpdatesEnabled: () => false,
  applyForcedGatewayUpdateStatus: (status: UpdateStatus) => status,
}));

vi.mock("@/services/api", () => ({
  api: {
    getVersionInfo: vi.fn(),
    checkForUpdates: vi.fn(),
    getAllReleaseNotes: vi.fn(),
    setCache: vi.fn(),
    triggerUpdate: vi.fn(),
    triggerRelayUpdate: vi.fn(),
  },
}));

function makeStatus(options: {
  gatewayVersion: string;
  relayIncludedInGatewayUpdate: boolean;
}): UpdateStatus {
  return {
    currentVersion: "v2.6.12",
    latestVersion: options.gatewayVersion,
    updateAvailable: true,
    releaseNotes: null,
    releaseUrl: null,
    lastCheckedAt: null,
    relayIncludedInGatewayUpdate: options.relayIncludedInGatewayUpdate,
    relay: {
      currentVersion: "v2.6.12",
      latestVersion: "v2.6.13",
      updateAvailable: true,
      releaseNotes: null,
      releaseUrl: null,
    },
  };
}

describe("UpdateSection", () => {
  beforeEach(() => {
    vi.mocked(confirm).mockReset().mockResolvedValue(true);
    vi.mocked(api.triggerUpdate).mockReset().mockResolvedValue({
      status: "updating",
      targetVersion: "v2.6.13",
    });
    vi.mocked(api.triggerRelayUpdate).mockReset().mockResolvedValue({
      status: "updating",
      targetVersion: "v2.6.13",
    });
    useUpdateStore.setState({
      status: null,
      isChecking: false,
      isUpdating: false,
      updatingComponent: null,
    });
  });

  it("keeps Gateway and Relay actions separate for a patch update", async () => {
    const status = makeStatus({
      gatewayVersion: "v2.6.13",
      relayIncludedInGatewayUpdate: false,
    });
    vi.mocked(api.getVersionInfo).mockResolvedValue(status);
    useUpdateStore.setState({ status });

    render(<UpdateSection canUpdate />);

    const gatewayButton = await screen.findByRole("button", {
      name: "Update Gateway to v2.6.13",
    });
    expect(screen.getByRole("button", { name: "Update Relay to v2.6.13" })).toBeInTheDocument();

    fireEvent.click(gatewayButton);
    await waitFor(() => expect(api.triggerUpdate).toHaveBeenCalledWith("v2.6.13"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.triggerRelayUpdate).not.toHaveBeenCalled();
  });

  it("coordinates Relay with a Gateway minor update after the interruption warning", async () => {
    const status = makeStatus({
      gatewayVersion: "v2.7.0",
      relayIncludedInGatewayUpdate: true,
    });
    vi.mocked(api.getVersionInfo).mockResolvedValue(status);
    useUpdateStore.setState({ status });

    render(<UpdateSection canUpdate />);

    expect(
      screen.queryByRole("button", { name: "Update Relay to v2.6.13" })
    ).not.toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Update Gateway v2.7.0 and Relay v2.6.13",
      })
    );

    await waitFor(() => expect(api.triggerUpdate).toHaveBeenCalledWith("v2.7.0"));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Restart Relay?" }));
    expect(useUpdateStore.getState().updatingComponent).toBe("gateway-relay");
  });

  it("shows one primary action and Relay release notes for a Relay-only update", async () => {
    const status: UpdateStatus = {
      ...makeStatus({
        gatewayVersion: "v2.6.12",
        relayIncludedInGatewayUpdate: false,
      }),
      latestVersion: null,
      updateAvailable: false,
      relay: {
        currentVersion: "v2.6.12",
        latestVersion: "v2.6.13",
        updateAvailable: true,
        releaseNotes: "Relay-only notes",
        releaseUrl: null,
      },
    };
    vi.mocked(api.getVersionInfo).mockResolvedValue(status);
    useUpdateStore.setState({ status });

    render(<UpdateSection canUpdate />);

    expect(await screen.findAllByRole("button", { name: "Update Relay to v2.6.13" })).toHaveLength(
      1
    );
    fireEvent.click(screen.getByRole("button", { name: "Release notes" }));

    expect(await screen.findByText("Relay-only notes")).toBeInTheDocument();
    expect(api.getAllReleaseNotes).not.toHaveBeenCalled();
  });
});
