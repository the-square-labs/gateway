import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, useConfirmDialog } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { useSystemConfigStore } from "@/stores/system-config";
import type { AuthProvisioningSettings } from "@/types";
import { AuthProvisioningSection } from "./AuthProvisioningSection";
import { applySmtpPreset } from "./smtp-presets";

const SETTINGS: AuthProvisioningSettings = {
  oidcAutoCreateUsers: true,
  oidcDefaultGroupId: "group-1",
  oidcRequireVerifiedEmail: true,
  oauthExtendedCallbackCompatibility: false,
  mfaExistingSessionGracePeriodDays: 3,
  mcpServerEnabled: true,
  mcpExtendedCompatibility: false,
  generalSettings: {
    publicUrl: "https://gateway.example.com",
    fileUploadMaxBytes: 100 * 1024 * 1024,
    fileOpenMaxBytes: 10 * 1024 * 1024,
    gatewayPublicIps: [],
    gatewayGrpcPublicTarget: null,
    gatewayGrpcLocalIp: null,
    relayAutoRecovery: true,
    features: {
      pkiEnabled: true,
      domainsEnabled: true,
      siemEnabled: true,
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

  it("persists the existing-session MFA grace period", async () => {
    api.setCache("settings:auth-provisioning", SETTINGS);
    const loadedSettings = { ...SETTINGS, mfaExistingSessionGracePeriodDays: 4 };
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(loadedSettings);
    const update = vi
      .spyOn(api, "updateAuthProvisioningSettings")
      .mockImplementation(async (input) => ({
        ...loadedSettings,
        mfaExistingSessionGracePeriodDays:
          input.mfaExistingSessionGracePeriodDays ??
          loadedSettings.mfaExistingSessionGracePeriodDays,
      }));
    const user = userEvent.setup();

    render(<AuthProvisioningSection canEdit />);

    await waitFor(() =>
      expect(
        screen.getByRole("spinbutton", { name: "Existing-session MFA grace period in days" })
      ).toHaveValue(4)
    );
    const gracePeriodInput = screen.getByRole("spinbutton", {
      name: "Existing-session MFA grace period in days",
    });
    await user.clear(gracePeriodInput);
    await user.type(gracePeriodInput, "5");
    await user.click(screen.getByRole("button", { name: "Save MFA grace period" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ mfaExistingSessionGracePeriodDays: 5 })
    );
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
    expect(screen.queryByText("Enable alpha inference?")).not.toBeInTheDocument();
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
            siemEnabled: true,
            inferenceEnabled: true,
          },
        }),
      })
    );
    expect(useSystemConfigStore.getState().config.features.inferenceEnabled).toBe(true);
  });

  it("keeps inference disabled by default without an alpha confirmation", async () => {
    api.setCache("settings:auth-provisioning", SETTINGS);
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(SETTINGS);
    const update = vi.spyOn(api, "updateAuthProvisioningSettings");
    render(
      <>
        <AuthProvisioningSection canEdit />
        <ConfirmDialog />
      </>
    );

    const inferenceToggle = await screen.findByRole("button", { name: "Enable inference" });
    expect(inferenceToggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Enable alpha inference?")).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it("persists the SIEM audit export toggle with the other Gateway features", async () => {
    api.setCache("settings:auth-provisioning", SETTINGS);
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(SETTINGS);
    const update = vi.spyOn(api, "updateAuthProvisioningSettings").mockImplementation(async () => ({
      ...SETTINGS,
      generalSettings: {
        ...SETTINGS.generalSettings,
        features: { ...SETTINGS.generalSettings.features, siemEnabled: false },
      },
    }));
    const user = userEvent.setup();

    render(<AuthProvisioningSection canEdit />);

    await user.click(await screen.findByRole("button", { name: "Enable SIEM audit export" }));
    const save = screen
      .getAllByRole("button", { name: "Save" })
      .find((button) => !(button as HTMLButtonElement).disabled);
    if (!save) throw new Error("General settings save action not found");
    await user.click(save);

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        generalSettings: expect.objectContaining({
          features: expect.objectContaining({ siemEnabled: false }),
        }),
      })
    );
    expect(useSystemConfigStore.getState().config.features.siemEnabled).toBe(false);
  });

  it("persists the bounded Gateway relay auto-recovery toggle", async () => {
    api.setCache("settings:auth-provisioning", SETTINGS);
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(SETTINGS);
    const update = vi
      .spyOn(api, "updateAuthProvisioningSettings")
      .mockImplementation(async (input) => ({
        ...SETTINGS,
        generalSettings: { ...SETTINGS.generalSettings, ...input.generalSettings },
      }));
    const user = userEvent.setup();

    render(<AuthProvisioningSection canEdit />);
    await user.click(
      await screen.findByRole("button", { name: "Enable Gateway relay auto-recovery" })
    );

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        generalSettings: expect.objectContaining({ relayAutoRecovery: false }),
      })
    );
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

  it("applies the Resend SMTP preset without adding a credential", () => {
    const draft = applySmtpPreset(
      {
        host: "smtp.example.com",
        port: "2525",
        tlsMode: "tls",
        username: "old-user",
        password: "secret",
        senderName: "Gateway",
        senderEmail: "security@example.com",
      },
      "resend"
    );

    expect(draft).toMatchObject({
      host: "smtp.resend.com",
      port: "587",
      tlsMode: "starttls",
      username: "resend",
      password: "secret",
    });
  });

  it("defaults unconfigured SMTP to Resend and hides its fixed connection fields", async () => {
    api.setCache("settings:auth-provisioning", SETTINGS);
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(SETTINGS);

    render(<AuthProvisioningSection canEdit />);

    expect(await screen.findByRole("combobox", { name: "SMTP provider" })).toHaveTextContent(
      "Resend"
    );
    expect(screen.queryByRole("textbox", { name: "SMTP host" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "SMTP port" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "SMTP username" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("SMTP password")).toBeInTheDocument();
  });

  it("asks for a recipient only when sending an SMTP test", async () => {
    api.setCache("settings:auth-provisioning", SETTINGS);
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(SETTINGS);
    const user = userEvent.setup();

    render(<AuthProvisioningSection canEdit />);

    expect(screen.queryByLabelText("Test recipient")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Send test" }));
    expect(screen.getByRole("heading", { name: "Send SMTP test" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "SMTP test email type" })).toHaveTextContent(
      "SMTP configuration"
    );
    expect(screen.getByLabelText("Test recipient")).toBeInTheDocument();
  });
});
