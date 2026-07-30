import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => api.invalidateCache("settings:auth-provisioning"));

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

    render(<AuthProvisioningSection canEdit />);

    const inferenceRow = (await screen.findByText("Inference")).parentElement?.parentElement;
    if (!inferenceRow) throw new Error("Inference settings row not found");
    await user.click(within(inferenceRow).getByRole("button", { name: "Enable inference" }));
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
