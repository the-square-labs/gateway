import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConfirmDialog } from "@/components/common/ConfirmDialog";
import { SetupWizardPage } from "./SetupWizard";
import { AdminAuthMethodStep } from "./setup-wizard/SetupFinalSteps";
import {
  type AdminDraft,
  getSetupSteps,
  isLoggingDraftValid,
  isOidcDraftValid,
} from "./setup-wizard/setup-wizard-model";

const CONFIG = {
  administratorCreated: false,
  phase: "configuration" as const,
  license: {
    completed: false,
    status: {
      status: "community",
      plan: "community",
      registrationStatus: "registered",
      paidLicenseStatus: "none",
      licensed: false,
      hasKey: false,
      keyLast4: null,
      licenseName: null,
      licenseMetadata: {},
      installationId: "installation-id",
      installationName: "Gateway",
      expiresAt: null,
      entitlementsVersion: 1,
      entitlements: {
        managedNodes: 100,
        users: 10,
        customPermissionGroups: 5,
        supportLevel: "community",
        features: [],
      },
      lastCheckedAt: null,
      lastValidAt: null,
      graceUntil: null,
      activeInstallationId: null,
      activeInstallationName: null,
      errorMessage: null,
      serverUrl: "https://license.wiolett.cloud",
    },
  },
  general: {
    publicUrl: null,
    gatewayGrpcPublicTarget: null,
    gatewayGrpcLocalIp: null,
  },
  networkSuggestions: {
    publicIps: ["203.0.113.10", "203.0.113.11"],
    localIps: ["192.168.1.10", "192.168.1.11"],
  },
  auth: { methods: { oidc: true, password: false, emailOtp: false } },
  smtp: {
    configured: false,
    host: null,
    port: null,
    tlsMode: null,
    username: null,
    passwordLast4: null,
    senderName: null,
    senderEmail: null,
    verifiedAt: null,
  },
  oidc: {
    configured: false,
    issuer: null,
    clientId: null,
    redirectUri: null,
    scopes: "openid email profile",
  },
  logging: {
    mode: "disabled",
    url: "",
    username: "",
    database: "gateway_logs",
    table: "logs",
    passwordLast4: null,
  },
  transport: { tlsEnabled: true },
};

const PENDING_STATUS = {
  state: "pending",
  code: { id: "code-id" },
  setupInProgress: false,
  currentSession: false,
};

const UNLOCKED = {
  unlocked: true,
  codeId: "code-id",
  csrfToken: "setup-csrf",
};

function response(status: number, body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function AdminMethodHarness({ onContinue }: { onContinue: () => void }) {
  const [admin, setAdmin] = useState<AdminDraft>({
    name: "",
    email: "",
    authMethod: null,
    password: "",
  });
  return (
    <AdminAuthMethodStep
      admin={admin}
      busy={false}
      enabledMethods={["password", "email_otp"]}
      setAdmin={setAdmin}
      onBack={() => undefined}
      onContinue={onContinue}
    />
  );
}

describe("SetupWizardPage", () => {
  afterEach(() => {
    act(() => useConfirmDialog.getState().close());
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("mounts shared confirmations during installer AI Workspace setup", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        response(200, {
          data: { ...PENDING_STATUS, setupInProgress: true, currentSession: true },
        })
      )
      .mockImplementationOnce(() =>
        response(200, {
          data: {
            ...CONFIG,
            phase: "ai_workspace",
            license: { ...CONFIG.license, completed: true },
          },
        })
      )
      .mockImplementationOnce(() => response(200, { data: { csrfToken: "setup-csrf" } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SetupWizardPage />);
    expect(await screen.findByRole("heading", { name: "AI Workspace" })).toBeInTheDocument();

    act(() => {
      useConfirmDialog.getState().show({
        title: "Review provider terms",
        description: "Review the provider terms before continuing.",
        confirmLabel: "Continue to authorization",
        onConfirm: vi.fn(),
      });
    });

    expect(screen.getByRole("dialog", { name: "Review provider terms" })).toBeInTheDocument();
  });

  it("restores an incomplete license choice before AI Workspace", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        response(200, {
          data: { ...PENDING_STATUS, setupInProgress: true, currentSession: true },
        })
      )
      .mockImplementationOnce(() => response(200, { data: { ...CONFIG, phase: "ai_workspace" } }))
      .mockImplementationOnce(() => response(200, { data: { csrfToken: "setup-csrf" } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SetupWizardPage />);

    expect(await screen.findByRole("heading", { name: "Gateway edition" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "AI Workspace" })).not.toBeInTheDocument();
  });

  it("keeps the license step open when paid activation fails", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        response(200, {
          data: { ...PENDING_STATUS, setupInProgress: true, currentSession: true },
        })
      )
      .mockImplementationOnce(() => response(200, { data: { ...CONFIG, phase: "ai_workspace" } }))
      .mockImplementationOnce(() => response(200, { data: { csrfToken: "setup-csrf" } }))
      .mockImplementationOnce(() =>
        response(409, { code: "LICENSE_IN_USE", message: "License is already active" })
      );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<SetupWizardPage />);
    const keyInput = await screen.findByLabelText("License key");
    await user.type(keyInput, "WLT-GW-PAID-KEY");
    await user.click(screen.getByRole("button", { name: "Activate license" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const [path, init] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(path).toBe("/api/setup/wizard/license/activate");
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("setup-csrf");
    expect(JSON.parse(String(init.body))).toEqual({ licenseKey: "WLT-GW-PAID-KEY" });
    expect(screen.getByRole("heading", { name: "Gateway edition" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "AI Workspace" })).not.toBeInTheDocument();
  });

  it("skips administrator method selection when only one method is enabled", () => {
    expect(getSetupSteps({ oidc: true, password: false, emailOtp: false })).not.toContain(
      "admin-auth"
    );
    expect(getSetupSteps({ oidc: false, password: true, emailOtp: true })).toContain("admin-auth");
  });

  it("requires an explicit administrator method selection before continuing", async () => {
    const onContinue = vi.fn();
    const user = userEvent.setup();
    render(<AdminMethodHarness onContinue={onContinue} />);

    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Email code" }));
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("rejects OIDC and ClickHouse URLs that the backend cannot accept", () => {
    expect(
      isOidcDraftValid(
        {
          issuer: "ftp://identity.example.com",
          clientId: "gateway",
          clientSecret: "secret",
          redirectUri: "https://gateway.example.com/auth/callback",
          scopes: "openid email",
        },
        false
      )
    ).toBe(false);
    expect(
      isOidcDraftValid(
        {
          issuer: "https://identity.example.com",
          clientId: "gateway",
          clientSecret: "secret",
          redirectUri: "https://gateway.example.com/auth/callback",
          scopes: "email profile",
        },
        false
      )
    ).toBe(false);
    expect(
      isLoggingDraftValid(
        {
          mode: "external",
          url: "javascript:alert(1)",
          username: "gateway",
          password: "secret",
          database: "gateway_logs",
          table: "logs",
        },
        false
      )
    ).toBe(false);
  });

  it("unlocks with the one-time code and never defaults public URL from browser origin", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => response(200, { data: PENDING_STATUS }))
      .mockImplementationOnce(() => response(200, { data: UNLOCKED }))
      .mockImplementationOnce(() => response(200, { data: CONFIG }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<SetupWizardPage />);
    const code = await screen.findByPlaceholderText("gws_…");
    await user.type(code, "gws_test-code");
    await user.click(screen.getByRole("button", { name: "Start setup" }));

    const publicUrl = await screen.findByPlaceholderText("https://gateway.example.com");
    expect(publicUrl).toHaveValue("");
    expect(publicUrl).not.toHaveValue(window.location.origin);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("hides setup-code entry while another setup session is active", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(() =>
      response(200, {
        data: { ...PENDING_STATUS, setupInProgress: true },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<SetupWizardPage />);

    expect(
      await screen.findByRole("heading", { name: "Gateway setup is in progress" })
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("gws_…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start setup" })).not.toBeInTheDocument();
  });

  it("restores the non-secret draft for the current setup session after reload", async () => {
    sessionStorage.setItem(
      "gateway:setup-draft:code-id",
      JSON.stringify({
        step: "oidc-config",
        publicUrl: "https://gateway.example.com",
        methods: { oidc: true, password: false, emailOtp: false },
        oidc: {
          issuer: "https://identity.example.com",
          clientId: "gateway-client",
          redirectUri: "https://gateway.example.com/auth/callback",
          scopes: "openid email profile",
        },
      })
    );
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        response(200, { data: { ...PENDING_STATUS, setupInProgress: true, currentSession: true } })
      )
      .mockImplementationOnce(() => response(200, { data: CONFIG }))
      .mockImplementationOnce(() => response(200, { data: { csrfToken: "setup-csrf" } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SetupWizardPage />);

    expect(await screen.findByRole("heading", { name: "Configure OIDC" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Issuer URL")).toHaveValue("https://identity.example.com");
    expect(screen.getByPlaceholderText("Client ID")).toHaveValue("gateway-client");
    expect(screen.getByPlaceholderText("Client secret")).toHaveValue("");
  });

  it("returns to the earliest step whose secret was cleared after reload", async () => {
    sessionStorage.setItem(
      "gateway:setup-draft:code-id",
      JSON.stringify({
        step: "finish",
        publicUrl: "http://localhost:3300",
        network: {
          grpcPublicTarget: "localhost:9443",
          grpcLocalIp: "",
        },
        methods: { oidc: false, password: true, emailOtp: false },
        smtpPreset: "resend",
        smtp: {
          host: "smtp.resend.com",
          port: "587",
          tlsMode: "starttls",
          username: "resend",
          senderName: "Gateway",
          senderEmail: "gateway@example.com",
        },
        admin: {
          name: "System Administrator",
          email: "admin@example.com",
          authMethod: "password",
        },
        logging: { mode: "disabled" },
      })
    );
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        response(200, { data: { ...PENDING_STATUS, setupInProgress: true, currentSession: true } })
      )
      .mockImplementationOnce(() =>
        response(200, {
          data: {
            ...CONFIG,
            auth: { methods: { oidc: false, password: true, emailOtp: false } },
          },
        })
      )
      .mockImplementationOnce(() => response(200, { data: { csrfToken: "setup-csrf" } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SetupWizardPage />);

    expect(
      await screen.findByRole("heading", { name: "Configure email delivery" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Review configuration" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("SMTP password")).toHaveValue("");
  });

  it("recomputes auto-derived endpoints when the public URL changes", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => response(200, { data: PENDING_STATUS }))
      .mockImplementationOnce(() => response(200, { data: UNLOCKED }))
      .mockImplementationOnce(() => response(200, { data: CONFIG }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<SetupWizardPage />);
    await user.type(await screen.findByPlaceholderText("gws_…"), "gws_test-code");
    await user.click(screen.getByRole("button", { name: "Start setup" }));
    const publicUrl = await screen.findByPlaceholderText("https://gateway.example.com");
    await user.type(publicUrl, "https://old.example.com");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const networkHeading = await screen.findByRole("heading", { name: "Gateway network" });
    await user.click(
      within(networkHeading.closest("section")!).getByRole("button", { name: "Back" })
    );
    const changedPublicUrl = await screen.findByPlaceholderText("https://gateway.example.com");
    await user.clear(changedPublicUrl);
    await user.type(changedPublicUrl, "https://new.example.com");
    await user.click(
      within(changedPublicUrl.closest("form")!).getByRole("button", { name: "Continue" })
    );

    expect(screen.getByRole("combobox", { name: "gRPC public target" })).toHaveValue(
      "new.example.com:9443"
    );
    const changedNetworkHeading = screen.getByRole("heading", { name: "Gateway network" });
    await user.click(
      within(changedNetworkHeading.closest("section")!).getByRole("button", { name: "Continue" })
    );
    const methodsHeading = await screen.findByRole("heading", { name: "Sign-in methods" });
    await user.click(
      within(methodsHeading.closest("section")!).getByRole("button", { name: "Continue" })
    );
    expect(await screen.findByPlaceholderText("Redirect URI")).toHaveValue(
      "https://new.example.com/auth/callback"
    );
  });

  it("switches to the in-progress screen if another browser claims setup first", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => response(200, { data: PENDING_STATUS }))
      .mockImplementationOnce(() =>
        response(409, {
          code: "SETUP_IN_PROGRESS",
          message: "Gateway setup is already in progress",
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<SetupWizardPage />);
    await user.type(await screen.findByPlaceholderText("gws_…"), "gws_test-code");
    await user.click(screen.getByRole("button", { name: "Start setup" }));

    expect(
      await screen.findByRole("heading", { name: "Gateway setup is in progress" })
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("gws_…")).not.toBeInTheDocument();
  });

  it("does not mutate setup between steps and applies the complete draft once", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => response(200, { data: PENDING_STATUS }))
      .mockImplementationOnce(() => response(200, { data: UNLOCKED }))
      .mockImplementationOnce(() => response(200, { data: CONFIG }))
      .mockImplementation(() => response(200, { data: { status: "ready_for_ai" } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<SetupWizardPage />);
    await user.type(await screen.findByPlaceholderText("gws_…"), "gws_test-code");
    await user.click(screen.getByRole("button", { name: "Start setup" }));
    await user.type(
      await screen.findByPlaceholderText("https://gateway.example.com"),
      "https://gateway.example.com"
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const networkHeading = await screen.findByRole("heading", { name: "Gateway network" });
    const networkSection = within(networkHeading.closest("section")!);
    expect(screen.getByRole("combobox", { name: "gRPC public target" })).toHaveValue(
      "gateway.example.com:9443"
    );
    expect(screen.getByRole("combobox", { name: "gRPC local IP" })).toHaveValue("192.168.1.10");

    await user.click(screen.getByRole("combobox", { name: "gRPC public target" }));
    expect(screen.getByRole("button", { name: /gateway\.example\.com:9443/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /203\.0\.113\.10:9443/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /203\.0\.113\.11:9443/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("combobox", { name: "gRPC local IP" }));
    expect(screen.getByRole("button", { name: /192\.168\.1\.10/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /192\.168\.1\.11/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(networkSection.getByRole("button", { name: "Continue" }));

    const methodsHeading = await screen.findByRole("heading", { name: "Sign-in methods" });
    await user.click(
      within(methodsHeading.closest("section")!).getByRole("button", { name: "Continue" })
    );

    await user.type(
      await screen.findByPlaceholderText("Issuer URL"),
      "https://identity.example.com"
    );
    await user.type(screen.getByPlaceholderText("Client ID"), "gateway-client");
    await user.type(screen.getByPlaceholderText("Client secret"), "client-secret");
    const oidcHeading = screen.getByRole("heading", { name: "Configure OIDC" });
    await user.click(
      within(oidcHeading.closest("section")!).getByRole("button", { name: "Continue" })
    );

    expect(
      await screen.findByRole("heading", { name: "Administrator details" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Administrator sign-in" })
    ).not.toBeInTheDocument();
    const fullName = await screen.findByPlaceholderText("Full name");
    await user.type(fullName, "System Administrator");
    await user.type(screen.getByPlaceholderText("Email"), "admin@example.com");
    await user.click(within(fullName.closest("form")!).getByRole("button", { name: "Continue" }));

    const loggingHeading = await screen.findByRole("heading", { name: "Structured logs" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await user.click(
      within(loggingHeading.closest("section")!).getByRole("button", { name: "Continue" })
    );
    expect(
      await screen.findByRole("heading", { name: "Review configuration" })
    ).toBeInTheDocument();
    expect(screen.getByText("https://identity.example.com")).toBeInTheDocument();
    expect(screen.getByText("gateway-client")).toBeInTheDocument();
    expect(screen.getByText("https://gateway.example.com/auth/callback")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await user.click(screen.getByRole("button", { name: "Apply configuration" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const [path, init] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(path).toBe("/api/setup/wizard/apply");
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("setup-csrf");
    expect(JSON.parse(String(init.body))).toMatchObject({
      publicUrl: "https://gateway.example.com",
      network: {
        grpcPublicTarget: "gateway.example.com:9443",
        grpcLocalIp: "192.168.1.10",
      },
      auth: {
        methods: { oidc: true, password: false, emailOtp: false },
        oidc: {
          issuer: "https://identity.example.com",
          clientId: "gateway-client",
          clientSecret: "client-secret",
        },
      },
      administrator: {
        name: "System Administrator",
        email: "admin@example.com",
        authMethod: "oidc",
      },
      logging: { mode: "disabled" },
    });
    expect(JSON.parse(String(init.body)).administrator).not.toHaveProperty("password");
    expect(await screen.findByRole("heading", { name: "Gateway edition" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue with Community" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    const [licensePath, licenseInit] = fetchMock.mock.calls[4] as [string, RequestInit];
    expect(licensePath).toBe("/api/setup/wizard/license/community");
    expect(new Headers(licenseInit.headers).get("X-CSRF-Token")).toBe("setup-csrf");
    expect(await screen.findByRole("heading", { name: "AI Workspace" })).toBeInTheDocument();
  });

  it("disables invalid steps and applies the shared Resend SMTP preset", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => response(200, { data: PENDING_STATUS }))
      .mockImplementationOnce(() => response(200, { data: UNLOCKED }))
      .mockImplementationOnce(() => response(200, { data: CONFIG }))
      .mockImplementation(() => response(200, { data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<SetupWizardPage />);
    await user.type(await screen.findByPlaceholderText("gws_…"), "gws_test-code");
    await user.click(screen.getByRole("button", { name: "Start setup" }));

    const publicUrl = await screen.findByPlaceholderText("https://gateway.example.com");
    const publicUrlContinue = screen.getByRole("button", { name: "Continue" });
    expect(publicUrlContinue).toBeDisabled();
    await user.type(publicUrl, "not-a-url");
    expect(publicUrlContinue).toBeDisabled();
    await user.clear(publicUrl);
    await user.type(publicUrl, "https://gateway.example.com");
    expect(publicUrlContinue).toBeEnabled();
    await user.click(publicUrlContinue);

    const networkHeading = await screen.findByRole("heading", { name: "Gateway network" });
    const networkSection = within(networkHeading.closest("section")!);
    const grpcPublicTarget = screen.getByRole("combobox", { name: "gRPC public target" });
    const networkContinue = networkSection.getByRole("button", { name: "Continue" });
    expect(networkContinue).toBeEnabled();
    await user.clear(grpcPublicTarget);
    expect(networkContinue).toBeDisabled();
    await user.type(grpcPublicTarget, "gateway.example.com:9443");
    expect(networkContinue).toBeEnabled();
    await user.click(networkContinue);

    const methodsHeading = await screen.findByRole("heading", { name: "Sign-in methods" });
    const methodsSection = within(methodsHeading.closest("section")!);
    await user.click(methodsSection.getByRole("button", { name: "Enable OIDC" }));
    const methodsContinue = methodsSection.getByRole("button", { name: "Continue" });
    expect(methodsContinue).toBeDisabled();
    await user.click(methodsSection.getByRole("button", { name: "Enable Password" }));
    expect(methodsContinue).toBeEnabled();
    await user.click(methodsContinue);

    const smtpHeading = await screen.findByRole("heading", { name: "Configure email delivery" });
    expect(screen.getByRole("combobox", { name: "SMTP provider" })).toHaveTextContent("Resend");
    expect(screen.queryByRole("textbox", { name: "SMTP host" })).not.toBeInTheDocument();
    const smtpContinue = within(smtpHeading.closest("section")!).getByRole("button", {
      name: "Continue",
    });
    expect(smtpContinue).toBeDisabled();
    await user.type(screen.getByLabelText("SMTP password"), "re_test_key");
    await user.type(screen.getByPlaceholderText("Sender email"), "gateway@example.com");
    expect(smtpContinue).toBeEnabled();
    expect(screen.queryByPlaceholderText("Send verification email to")).not.toBeInTheDocument();
  });
});
