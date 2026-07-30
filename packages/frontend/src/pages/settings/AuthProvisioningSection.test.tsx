import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, useConfirmDialog } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { useSystemConfigStore } from "@/stores/system-config";
import type { AuthProvisioningSettings } from "@/types";
import { AuthProvisioningSection } from "./AuthProvisioningSection";

const SETTINGS: AuthProvisioningSettings = {
  oidcAutoCreateUsers: true,
  oidcDefaultGroupId: "group-1",
  oidcRequireVerifiedEmail: true,
  oauthExtendedCallbackCompatibility: false,
  mcpServerEnabled: true,
  mcpExtendedCompatibility: false,
  generalSettings: {
    fileUploadMaxBytes: 100 * 1024 * 1024,
    fileOpenMaxBytes: 10 * 1024 * 1024,
    gatewayPublicIps: [],
    gatewayGrpcPublicTarget: null,
    gatewayGrpcLocalIp: null,
    features: {
      pkiEnabled: true,
      domainsEnabled: true,
      inferenceEnabled: false,
    },
  },
  networkSecurity: {
    clientIpSource: "auto",
    trustedProxyCidrs: [],
    trustCloudflareHeaders: false,
  },
  outboundWebhookPolicy: {
    allowPrivateNetworks: false,
    allowedPrivateCidrs: [],
  },
  currentRequestIp: { source: "unknown" },
  availableGroups: [],
};

describe("AuthProvisioningSection inference setting", () => {
  afterEach(() => {
    api.invalidateCache("settings:auth-provisioning");
    useConfirmDialog.getState().close();
  });

  it("persists inference beside the other Gateway feature settings", async () => {
    api.setCache("settings:auth-provisioning", SETTINGS);
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(SETTINGS);
    const update = vi.spyOn(api, "updateAuthProvisioningSettings").mockImplementation(async () => ({
      ...SETTINGS,
      generalSettings: {
        ...SETTINGS.generalSettings,
        features: { ...SETTINGS.generalSettings.features, inferenceEnabled: true },
      },
    }));
    const user = userEvent.setup();

    render(
      <>
        <AuthProvisioningSection canEdit />
        <ConfirmDialog />
      </>
    );

    const inferenceRow = (await screen.findByText("Inference")).parentElement?.parentElement;
    if (!inferenceRow) throw new Error("Inference settings row not found");
    await user.click(within(inferenceRow).getByRole("button", { name: "Enable inference" }));
    expect(
      screen.getByText(
        "Inference is currently in alpha testing and has not been thoroughly validated. It may behave unexpectedly, fail, or change without notice. Enable it only if you accept the risk of unstable behavior."
      )
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Enable anyway" }));
    const save = screen
      .getAllByRole("button", { name: "Save" })
      .find((button) => !(button as HTMLButtonElement).disabled);
    if (!save) throw new Error("General settings save action not found");
    await user.click(save);

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        generalSettings: expect.objectContaining({
          features: {
            pkiEnabled: true,
            domainsEnabled: true,
            inferenceEnabled: true,
          },
        }),
      })
    );
    expect(useSystemConfigStore.getState().config.features.inferenceEnabled).toBe(true);
  });

  it("keeps inference disabled when the alpha warning is dismissed", async () => {
    api.setCache("settings:auth-provisioning", SETTINGS);
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(SETTINGS);
    const update = vi.spyOn(api, "updateAuthProvisioningSettings");
    const user = userEvent.setup();

    render(
      <>
        <AuthProvisioningSection canEdit />
        <ConfirmDialog />
      </>
    );

    const inferenceToggle = await screen.findByRole("button", { name: "Enable inference" });
    expect(inferenceToggle).toHaveAttribute("aria-pressed", "false");
    await user.click(inferenceToggle);
    await user.click(screen.getByRole("button", { name: "Keep disabled" }));

    expect(inferenceToggle).toHaveAttribute("aria-pressed", "false");
    expect(update).not.toHaveBeenCalled();
  });

  it("persists extended MCP compatibility", async () => {
    api.setCache("settings:auth-provisioning", SETTINGS);
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(SETTINGS);
    const update = vi.spyOn(api, "updateAuthProvisioningSettings").mockResolvedValue({
      ...SETTINGS,
      mcpExtendedCompatibility: true,
    });
    const user = userEvent.setup();

    render(<AuthProvisioningSection canEdit />);

    await user.click(
      await screen.findByRole("button", { name: "Enable extended MCP compatibility" })
    );

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        mcpExtendedCompatibility: true,
      })
    );
  });
});
