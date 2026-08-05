import { startRegistration } from "@simplewebauthn/browser";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { DEFAULT_SYSTEM_CONFIG, useSystemConfigStore } from "@/stores/system-config";
import { makeUser } from "@/test/fixtures";
import { Profile } from "./Profile";

vi.mock("@simplewebauthn/browser", () => ({ startRegistration: vi.fn() }));

vi.mock("@/pages/inference/InferenceUsagePanels", () => ({
  InferenceUsage: () => <section>Inference usage panel</section>,
}));
vi.mock("@/pages/inference/InferenceTokensSection", () => ({
  InferenceTokensSection: () => <section>Inference token authorizations</section>,
}));
vi.mock("@/pages/settings/ApiTokensSection", () => ({
  ApiTokensSection: () => <section>Gateway API authorizations</section>,
}));
vi.mock("@/pages/settings/OAuthApplicationsSection", () => ({
  OAuthApplicationsSection: () => <section>OAuth authorizations</section>,
}));

describe("Profile", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(startRegistration).mockReset();
    useAuthStore.setState({
      user: makeUser({
        name: "Alex Gateway",
        email: "alex@example.com",
        authMethod: "oidc",
        scopes: ["inference:use", "inference:tokens:manage"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    useSystemConfigStore.setState({
      config: {
        ...DEFAULT_SYSTEM_CONFIG,
        features: { ...DEFAULT_SYSTEM_CONFIG.features, inferenceEnabled: true },
      },
      loaded: true,
      isLoading: false,
    });
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 0,
    });
    vi.spyOn(api, "listProxyHosts").mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    });
    vi.spyOn(api, "listDatabases").mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 200, total: 0, totalPages: 0 },
    });
    vi.spyOn(api, "listCurrentUserSessions").mockResolvedValue([]);
  });

  it("keeps personal preferences and inference limits on the Preferences tab", () => {
    renderProfile("/profile");

    expect(screen.getByRole("heading", { name: "Profile", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Alex Gateway")).toBeInTheDocument();
    expect(screen.getByText("Inference usage panel")).toBeInTheDocument();
    expect(screen.queryByText("Gateway API authorizations")).not.toBeInTheDocument();

    const profile = screen.getByText("Alex Gateway");
    const usage = screen.getByText("Inference usage panel");
    const theme = screen.getByText("Theme");
    expect(profile.compareDocumentPosition(usage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(usage.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("groups API, OAuth, and inference credentials on the Authorizations tab", async () => {
    const user = userEvent.setup();
    renderProfile("/profile/authorizations");

    expect(screen.getByText("Gateway API authorizations")).toBeInTheDocument();
    expect(screen.getByText("OAuth authorizations")).toBeInTheDocument();
    expect(screen.getByText("Inference token authorizations")).toBeInTheDocument();
    expect(screen.queryByText("Inference usage panel")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Preferences" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/profile");
  });

  it("returns unknown profile tabs to Preferences", async () => {
    renderProfile("/profile/unknown");

    expect(await screen.findByTestId("location")).toHaveTextContent("/profile");
    expect(screen.getByRole("tab", { name: "Preferences" })).toHaveAttribute(
      "data-state",
      "active"
    );
  });

  it("renders the OIDC browser session and keeps the header action on the shared Button primitive", async () => {
    vi.spyOn(api, "listCurrentUserSessions").mockResolvedValue([
      {
        id: "oidc-session",
        authMethod: "oidc",
        createdAt: Date.now() - 60_000,
        lastSeenAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        ipAddress: "203.0.113.10",
        userAgent: "Gateway test browser",
        mfaSatisfiedAt: null,
        isCurrent: true,
      },
      {
        id: "other-oidc-session",
        authMethod: "oidc",
        createdAt: Date.now() - 120_000,
        lastSeenAt: Date.now() - 60_000,
        expiresAt: Date.now() + 60_000,
        ipAddress: "203.0.113.11",
        userAgent: "Other Gateway browser",
        mfaSatisfiedAt: null,
        isCurrent: false,
      },
    ]);

    renderProfile("/profile");

    expect(await screen.findByText("This browser")).toBeInTheDocument();
    expect(screen.getByText("This browser").closest("div.flex.flex-col")).toHaveClass(
      "bg-muted/60",
      "dark:bg-muted"
    );
    expect(screen.getByText(/oidc · 203\.0\.113\.10/i)).toBeInTheDocument();
    const deviceIcons = screen.getAllByTitle("Desktop computer");
    expect(deviceIcons).toHaveLength(2);
    expect(deviceIcons[0]).toHaveClass("h-10", "w-10", "bg-card");
    expect(deviceIcons[1]).toHaveClass("bg-muted");

    // A raw or one-off button cannot satisfy this contract: data-button is
    // emitted only by the shared Button primitive.
    const signOutOtherSessions = screen.getByRole("button", { name: "Sign out other sessions" });
    expect(signOutOtherSessions).toHaveAttribute("data-button");
    expect(signOutOtherSessions).toHaveClass("h-9", "px-4");
    expect(signOutOtherSessions.parentElement).not.toHaveClass("[&_[data-button]]:h-9");
    expect(
      screen.getByRole("button", { name: "Revoke session from Other Gateway browser" })
    ).toHaveClass("h-9", "w-9");
  });

  it("hides the sign-out-others action when this is the only browser session", async () => {
    vi.spyOn(api, "listCurrentUserSessions").mockResolvedValue([
      {
        id: "current-session",
        authMethod: "oidc",
        createdAt: Date.now() - 60_000,
        lastSeenAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        ipAddress: null,
        userAgent: null,
        mfaSatisfiedAt: null,
        isCurrent: true,
      },
    ]);

    renderProfile("/profile");

    expect(await screen.findByText("This browser")).toBeInTheDocument();
    expect(screen.getByText("This browser").closest("div.flex.flex-col")).not.toHaveClass(
      "bg-muted/60"
    );
    expect(
      screen.queryByRole("button", { name: "Sign out other sessions" })
    ).not.toBeInTheDocument();
    expect(screen.getByTitle("Unknown device")).toHaveClass("bg-muted");
  });

  it("manages passkeys in a dialog and derives a platform passkey name", async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      user: makeUser({ authMethod: "password" }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getCurrentUserMfaStatus").mockResolvedValue({
      totpConfigured: false,
      passkeyCount: 0,
      recoveryCodeCount: 0,
      required: false,
    });
    vi.spyOn(api, "listCurrentUserPasskeys").mockResolvedValue([]);
    vi.spyOn(api, "beginCurrentUserPasskeyRegistration").mockResolvedValue({});
    vi.spyOn(api, "finishCurrentUserPasskeyRegistration").mockResolvedValue();
    vi.mocked(startRegistration).mockResolvedValue({
      authenticatorAttachment: "platform",
    } as never);

    renderProfile("/profile");

    await user.click(await screen.findByRole("button", { name: "Manage Passkeys" }));
    expect(screen.getByRole("heading", { name: "Manage Passkeys" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add passkey" }));
    expect(api.finishCurrentUserPasskeyRegistration).toHaveBeenCalledWith(
      expect.anything(),
      "This device's passkey"
    );
  });

  it("filters passkeys in the shared searchable list shell", async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      user: makeUser({ authMethod: "password" }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getCurrentUserMfaStatus").mockResolvedValue({
      totpConfigured: false,
      passkeyCount: 2,
      recoveryCodeCount: 0,
      required: false,
    });
    vi.spyOn(api, "listCurrentUserPasskeys").mockResolvedValue([
      {
        id: "passkey-1",
        name: "iCloud Keychain",
        lastUsedAt: null,
        createdAt: "2026-08-03T00:00:00.000Z",
      },
      {
        id: "passkey-2",
        name: "Security key",
        lastUsedAt: null,
        createdAt: "2026-08-03T00:00:00.000Z",
      },
    ]);

    renderProfile("/profile");

    await user.click(await screen.findByRole("button", { name: "Manage Passkeys" }));
    const search = screen.getByPlaceholderText("Search passkeys...");
    expect(screen.getByText("iCloud Keychain")).toBeInTheDocument();
    expect(screen.getByText("Security key")).toBeInTheDocument();

    await user.type(search, "security");

    expect(screen.queryByText("iCloud Keychain")).not.toBeInTheDocument();
    expect(screen.getByText("Security key")).toBeInTheDocument();
  });

  it("sets up TOTP in a dialog, then shows one-time recovery codes", async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      user: makeUser({ authMethod: "password" }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getCurrentUserMfaStatus").mockResolvedValue({
      totpConfigured: false,
      passkeyCount: 0,
      recoveryCodeCount: 0,
      required: false,
    });
    vi.spyOn(api, "listCurrentUserPasskeys").mockResolvedValue([]);
    vi.spyOn(api, "beginCurrentUserTotpSetup").mockResolvedValue({
      secret: "ABC123",
      uri: "otpauth://totp/Gateway:test@example.com?secret=ABC123",
    });
    vi.spyOn(api, "confirmCurrentUserTotpSetup").mockResolvedValue([
      "code-1",
      "code-2",
      "code-3",
      "code-4",
      "code-5",
      "code-6",
      "code-7",
      "code-8",
      "code-9",
      "code-10",
    ]);

    renderProfile("/profile");

    await user.click(await screen.findByRole("button", { name: "Manage TOTP" }));
    expect(await screen.findByTitle("TOTP setup QR code")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("6-digit code"), "123456");
    await user.click(screen.getByRole("button", { name: "Activate TOTP" }));

    expect(await screen.findByRole("heading", { name: "Save recovery codes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy recovery codes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print" })).toBeInTheDocument();
    expect(screen.getAllByRole("textbox", { name: /Recovery code \d+/ })).toHaveLength(10);
  });

  it("requires confirmation before resetting an existing TOTP factor", async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      user: makeUser({ authMethod: "password" }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getCurrentUserMfaStatus").mockResolvedValue({
      totpConfigured: true,
      passkeyCount: 1,
      recoveryCodeCount: 10,
      required: false,
    });
    vi.spyOn(api, "listCurrentUserPasskeys").mockResolvedValue([]);
    vi.spyOn(api, "resetCurrentUserTotp").mockResolvedValue();
    vi.spyOn(api, "beginCurrentUserTotpSetup").mockResolvedValue({
      secret: "NEXT123",
      uri: "otpauth://totp/Gateway:test@example.com?secret=NEXT123",
    });

    renderProfile("/profile");

    await user.click(await screen.findByRole("button", { name: "Manage TOTP" }));
    expect(screen.getByRole("heading", { name: "TOTP is already configured" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset & reconfigure" }));

    expect(api.resetCurrentUserTotp).toHaveBeenCalledOnce();
    expect(await screen.findByTitle("TOTP setup QR code")).toBeInTheDocument();
  });
});

function renderProfile(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route
          path="/profile/:tab?"
          element={
            <>
              <Profile />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}
