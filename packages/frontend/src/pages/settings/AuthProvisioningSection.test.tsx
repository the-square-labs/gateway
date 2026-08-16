import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, useConfirmDialog } from "@/components/common/ConfirmDialog";
import { PageTransition } from "@/components/common/PageTransition";
import { PoweredByFooter } from "@/components/common/PoweredByFooter";
import { api } from "@/services/api";
import { useAppStatusStore } from "@/stores/app-status";
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
    relayGrantTtlHours: 4,
    shutdown: {
      userRequestDrainSeconds: 30,
      structuredLogDrainSeconds: 5,
      finalizationTimeoutSeconds: 10,
    },
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
    useAppStatusStore.getState().clearGatewayRestarting();
  });

  it("keeps settings and its footer hidden until the first settings snapshot is complete", async () => {
    api.invalidateCache("settings:auth-provisioning");
    let resolveSettings!: (settings: AuthProvisioningSettings) => void;
    vi.spyOn(api, "getAuthProvisioningSettings").mockReturnValueOnce(
      new Promise<AuthProvisioningSettings>((resolve) => {
        resolveSettings = resolve;
      })
    );

    render(
      <PageTransition>
        <AuthProvisioningSection canEdit section="general" />
        <PoweredByFooter />
      </PageTransition>
    );

    const transition = document.querySelector<HTMLElement>("[data-page-transition]");
    expect(transition).toHaveStyle({ visibility: "hidden" });
    expect(screen.getByText(/Powered by/)).not.toBeVisible();

    await act(async () => resolveSettings(SETTINGS));

    await waitFor(() => {
      expect(transition).toHaveStyle({ visibility: "visible" });
      expect(screen.getByText(/Powered by/)).toBeVisible();
    });
  });

  it("releases the first-page transition when the settings request fails", async () => {
    api.invalidateCache("settings:auth-provisioning");
    vi.spyOn(api, "getAuthProvisioningSettings").mockRejectedValueOnce(
      new Error("settings unavailable")
    );

    render(
      <PageTransition>
        <AuthProvisioningSection canEdit section="general" />
        <PoweredByFooter />
      </PageTransition>
    );

    const transition = document.querySelector<HTMLElement>("[data-page-transition]");
    expect(transition).toHaveStyle({ visibility: "hidden" });

    await waitFor(() => {
      expect(transition).toHaveStyle({ visibility: "visible" });
      expect(screen.getByText(/Powered by/)).toBeVisible();
    });
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

  it("enables explicit saves and marks each edited authentication panel dirty", async () => {
    const settings = {
      ...SETTINGS,
      logging: {
        mode: "external" as const,
        url: "https://clickhouse.example.com",
        username: "gateway",
        passwordLast4: "1234",
        database: "gateway_logs",
        table: "logs",
        requestTimeoutMs: 5000,
      },
    };
    api.setCache("settings:auth-provisioning", settings);
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(settings);
    const user = userEvent.setup();

    render(<AuthProvisioningSection canEdit />);

    const oidcSave = await screen.findByRole("button", { name: "Save OIDC provider" });
    const loggingSave = screen.getByRole("button", { name: "Save structured logging storage" });
    const mfaSave = screen.getByRole("button", { name: "Save MFA grace period" });
    const smtpSave = screen.getByRole("button", { name: "Save SMTP settings" });
    const oidcPanel = screen.getByText("OIDC provider").closest("div.border") as HTMLElement;
    const loggingPanel = screen
      .getByText("Structured logging storage")
      .closest("div.border") as HTMLElement;
    const mfaPanel = screen
      .getByText("Multi-factor authentication")
      .closest("div.border") as HTMLElement;
    const smtpPanel = screen
      .getByText("Authentication email (SMTP)")
      .closest("div.border") as HTMLElement;

    expect(oidcSave).toBeDisabled();
    expect(loggingSave).toBeDisabled();
    expect(mfaSave).toBeDisabled();
    expect(smtpSave).toBeDisabled();
    expect(smtpSave.querySelector("svg")).not.toBeNull();

    await user.type(within(oidcPanel).getByPlaceholderText(/id\.example\.com/), "https://id.test");
    const loggingUrl = within(loggingPanel).getByDisplayValue("https://clickhouse.example.com");
    await user.clear(loggingUrl);
    await user.type(loggingUrl, "https://clickhouse.test");
    const mfaInput = within(mfaPanel).getByRole("spinbutton", {
      name: "Existing-session MFA grace period in days",
    });
    await user.clear(mfaInput);
    await user.type(mfaInput, "4");
    await user.type(within(smtpPanel).getByLabelText("Sender email"), "security@example.com");

    expect(oidcSave).toBeEnabled();
    expect(loggingSave).toBeEnabled();
    expect(mfaSave).toBeEnabled();
    expect(smtpSave).toBeEnabled();
    for (const panel of [oidcPanel, loggingPanel, mfaPanel, smtpPanel]) {
      expect(panel).toHaveStyle({ borderColor: "var(--color-warning)" });
    }
  });

  it("persists graceful shutdown settings in the separate Gateway panel", async () => {
    api.setCache("settings:auth-provisioning", SETTINGS);
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(SETTINGS);
    const update = vi
      .spyOn(api, "updateAuthProvisioningSettings")
      .mockImplementation(async (input) => ({
        ...SETTINGS,
        generalSettings: {
          ...SETTINGS.generalSettings,
          shutdown: input.generalSettings?.shutdown ?? SETTINGS.generalSettings.shutdown,
        },
      }));
    const user = userEvent.setup();

    render(<AuthProvisioningSection canEdit />);

    const input = await screen.findByRole("spinbutton", { name: "User request drain in seconds" });
    const save = screen.getByRole("button", { name: "Save graceful shutdown settings" });
    expect(save).toBeDisabled();
    await user.clear(input);
    await user.type(input, "25");
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        generalSettings: {
          shutdown: {
            userRequestDrainSeconds: 25,
            structuredLogDrainSeconds: 5,
            finalizationTimeoutSeconds: 10,
          },
        },
      })
    );
  });

  it("shows the restart screen instead of reloading on a fixed timer", async () => {
    const settings = {
      ...SETTINGS,
      webTransport: {
        tlsEnabled: false,
        restartRequired: false,
        directAccess: false,
        targetUrl: null,
      },
    };
    api.setCache("settings:auth-provisioning", settings);
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(settings);
    vi.spyOn(api, "updateAuthProvisioningSettings").mockResolvedValue({
      ...settings,
      webTransport: {
        tlsEnabled: true,
        restartRequired: true,
        directAccess: false,
        targetUrl: null,
      },
    });
    const user = userEvent.setup();

    render(<AuthProvisioningSection canEdit section="general" />);
    await user.click(await screen.findByRole("button", { name: "Enable internal HTTPS" }));

    await waitFor(() =>
      expect(useAppStatusStore.getState()).toMatchObject({
        gatewayRestartingActive: true,
        gatewayRestartTargetUrl: null,
      })
    );
  });

  it("rejects a graceful shutdown total above the Docker safety budget", async () => {
    api.setCache("settings:auth-provisioning", SETTINGS);
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(SETTINGS);
    const user = userEvent.setup();

    render(<AuthProvisioningSection canEdit />);

    const input = await screen.findByRole("spinbutton", { name: "User request drain in seconds" });
    await user.clear(input);
    await user.type(input, "40");

    expect(screen.getByText("55 seconds")).toHaveClass("text-destructive");
    expect(
      screen.getByText("The combined deadline must not exceed 50 seconds.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save graceful shutdown settings" })).toBeDisabled();
  });

  it("disables graceful shutdown editing for read-only viewers", async () => {
    api.setCache("settings:auth-provisioning", SETTINGS);
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(SETTINGS);

    render(<AuthProvisioningSection canEdit={false} />);

    expect(
      await screen.findByRole("spinbutton", { name: "User request drain in seconds" })
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save graceful shutdown settings" })).toBeDisabled();
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

  it("shows the existing informational modal only when saving a changed relay TTL above 24 hours", async () => {
    api.setCache("settings:auth-provisioning", SETTINGS);
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue(SETTINGS);
    const update = vi
      .spyOn(api, "updateAuthProvisioningSettings")
      .mockImplementation(async (input) => ({
        ...SETTINGS,
        generalSettings: { ...SETTINGS.generalSettings, ...input.generalSettings },
      }));
    const user = userEvent.setup();
    render(
      <>
        <AuthProvisioningSection canEdit />
        <ConfirmDialog />
      </>
    );

    const input = await screen.findByRole("spinbutton", { name: "Relay grant lifetime hours" });
    await user.clear(input);
    await user.type(input, "25");
    const save = screen
      .getAllByRole("button", { name: "Save" })
      .find((button) => !(button as HTMLButtonElement).disabled);
    if (!save) throw new Error("General settings save action not found");
    await user.click(save);

    expect(await screen.findByText("Use a long relay grant lifetime?")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        generalSettings: expect.objectContaining({ relayGrantTtlHours: 25 }),
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
