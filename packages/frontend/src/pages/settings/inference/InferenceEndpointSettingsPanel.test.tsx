import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import { ConfirmDialog, useConfirmDialog } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { renderWithRouter } from "@/test/render";
import { InferenceEndpointSettingsPanel } from "./InferenceEndpointSettingsPanel";

describe("InferenceEndpointSettingsPanel", () => {
  afterEach(() => {
    api.invalidateCache("req:/api/inference/settings");
    useConfirmDialog.getState().close();
    vi.restoreAllMocks();
  });

  it("updates the endpoint gate and explains CLI and Codex Desktop setup", async () => {
    vi.spyOn(api, "getInferenceSettings").mockResolvedValue({
      harnessSpecificEndpointsEnabled: false,
    });
    const update = vi.spyOn(api, "updateInferenceSettings").mockResolvedValue({
      harnessSpecificEndpointsEnabled: true,
    });
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <InferenceEndpointSettingsPanel canManage />
        <ConfirmDialog />
      </>
    );

    const toggle = await screen.findByRole("button", {
      name: "Enable harness-specific endpoints",
    });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("/v1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Set up a harness" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("npx -y @wiolett/gateway-inference@latest")).toBeInTheDocument();
    expect(screen.getByText(/setup codex/)).toBeInTheDocument();
    expect(screen.getByText("Codex Desktop requires extra setup")).toBeInTheDocument();
    expect(screen.getByText(/Sign in to an OpenAI account/)).toBeInTheDocument();

    const closeButtons = within(dialog).getAllByRole("button", { name: "Close" });
    await user.click(closeButtons.at(-1)!);
    await user.click(toggle);
    expect(screen.getByText("Enable unstable harness endpoints?")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Harness APIs are unstable and change frequently. This feature has barely been tested and may stop working at any time. Enable it only if you accept the risk."
      )
    ).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Enable anyway" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ harnessSpecificEndpointsEnabled: true })
    );
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the endpoint switch read-only without provider management scope", async () => {
    vi.spyOn(api, "getInferenceSettings").mockResolvedValue({
      harnessSpecificEndpointsEnabled: true,
    });

    renderWithRouter(<InferenceEndpointSettingsPanel canManage={false} />);

    expect(
      await screen.findByRole("button", { name: "Enable harness-specific endpoints" })
    ).toBeDisabled();
  });
});
