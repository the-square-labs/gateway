import { startAuthentication } from "@simplewebauthn/browser";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "@/pages/Login";
import { useAuthStore } from "@/stores/auth";
import { renderWithRouter } from "@/test/render";

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ isAuthenticated: false });
});

describe("LoginPage password reset", () => {
  it("shows the reset-link account between the centered title and password field", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/auth/methods") {
        return Response.json({ oidc: true, password: true, emailOtp: false, passkeyLogin: false });
      }
      if (path === "/auth/password/reset/profile") {
        return Response.json({
          name: "Alex Gateway",
          email: "alex@example.com",
          avatarUrl: null,
          groupName: "system-admin",
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    renderWithRouter(<LoginPage />, {
      path: "/reset-password",
      route: "/reset-password?token=valid-reset-token",
    });

    expect(await screen.findByRole("heading", { name: "Set a new password" })).toHaveClass(
      "text-center"
    );
    expect(screen.getByText("Alex Gateway")).toBeInTheDocument();
    expect(screen.getByText("alex@example.com")).toBeInTheDocument();
    expect(screen.getByText("system-admin")).toBeInTheDocument();
    const passwordInput = screen.getByPlaceholderText("New password");
    expect(passwordInput).toHaveAttribute("type", "password");
    expect(passwordInput).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByRole("button", { name: "Save new password" })).toBeDisabled();
    fireEvent.change(passwordInput, { target: { value: "12345678" } });
    expect(screen.getByRole("button", { name: "Save new password" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(passwordInput).toHaveAttribute("type", "text");
    expect(
      screen.queryByText("Password does not meet the configured policy")
    ).not.toBeInTheDocument();
  });
});

describe("LoginPage email-first sign-in", () => {
  it("renders injected methods immediately without requesting them again", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    renderWithRouter(
      <LoginPage
        initialMethods={{ oidc: true, password: true, emailOtp: false, passkeyLogin: false }}
      />,
      { path: "/login", route: "/login" }
    );

    expect(screen.getByRole("button", { name: "Sign in with SSO" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with Email" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the sign-in button loading while Gateway navigation starts", async () => {
    const onComplete = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/auth/email/continue") return Response.json({ method: "password" });
      if (path === "/auth/password/login") return Response.json({ ok: true });
      throw new Error(`Unexpected request: ${path}`);
    });

    renderWithRouter(
      <LoginPage
        initialMethods={{ oidc: false, password: true, emailOtp: false, passkeyLogin: false }}
        onComplete={onComplete}
      />,
      {
        path: "/login",
        route: "/login?return_to=http%3A%2F%2Flocalhost%3A3000%2Fproxy-hosts%2Froute-1%3Ftab%3Dssl",
      }
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign in with Email" }));
    fireEvent.change(screen.getByPlaceholderText("Email"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByPlaceholderText("Password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith("/proxy-hosts/route-1?tab=ssl"));
    const signInButton = screen.getByRole("button", { name: "Sign in" });
    expect(signInButton).toBeDisabled();
    expect(signInButton.querySelector(".animate-spin")).not.toBeNull();
  });

  it("shows enabled method choices with SSO as the primary action", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ oidc: true, password: true, emailOtp: true, passkeyLogin: true })
    );

    renderWithRouter(<LoginPage />, { path: "/login", route: "/login" });

    expect(await screen.findByRole("button", { name: "Sign in with SSO" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with Email" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with Passkey" })).toBeInTheDocument();
  });

  it("shows a retry state when sign-in methods cannot be loaded", async () => {
    let attempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Network unavailable");
      return Response.json({ oidc: false, password: true, emailOtp: false, passkeyLogin: false });
    });

    renderWithRouter(<LoginPage />, { path: "/login", route: "/login" });

    expect(await screen.findByText("Unable to load sign-in methods.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: "Sign in with Email" })).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it("replaces passkey prompt cancellation with a helpful message", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/auth/methods") {
        return Response.json({ oidc: false, password: false, emailOtp: false, passkeyLogin: true });
      }
      if (path === "/auth/passkeys/options") return Response.json({ challenge: "challenge-1" });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.mocked(startAuthentication).mockRejectedValueOnce(
      Object.assign(new Error("The operation either timed out or was not allowed"), {
        name: "NotAllowedError",
      })
    );

    renderWithRouter(<LoginPage />, { path: "/login", route: "/login" });

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Passkey" }));

    expect(
      await screen.findByText(
        "Passkey sign-in was cancelled. Try again or choose another sign-in method."
      )
    ).toBeInTheDocument();
  });

  it("continues from email directly to the OTP screen when the server selects email OTP", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/auth/methods") {
        return Response.json({ oidc: false, password: true, emailOtp: true, passkeyLogin: false });
      }
      if (path === "/auth/email/continue") {
        return Response.json({ method: "email_otp", challengeId: "challenge-1" });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    renderWithRouter(<LoginPage />, { path: "/login", route: "/login" });

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Email" }));
    fireEvent.change(await screen.findByPlaceholderText("Email"), {
      target: { value: "otp@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("6-digit code")).toBeInTheDocument();
  });

  it("offers a configured passkey as the MFA factor even when direct passkey sign-in is disabled", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/auth/methods") {
        return Response.json({ oidc: false, password: true, emailOtp: false, passkeyLogin: false });
      }
      if (path === "/auth/email/continue") return Response.json({ method: "password" });
      if (path === "/auth/password/login") {
        return Response.json({
          ok: true,
          mfaRequired: true,
          mfaPasskeyAvailable: true,
          challengeId: "mfa-challenge-1",
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    renderWithRouter(<LoginPage />, { path: "/login", route: "/login" });

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Email" }));
    fireEvent.change(await screen.findByPlaceholderText("Email"), {
      target: { value: "passkey@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByPlaceholderText("Password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(
      await screen.findByRole("heading", { name: "Two-factor authentication" })
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Two-factor authentication" })).toHaveClass(
      "justify-center"
    );
    expect(screen.getByRole("button", { name: "Verify" }).parentElement).toHaveClass(
      "flex",
      "gap-2"
    );
    expect(screen.getByPlaceholderText("Authenticator code")).toHaveAttribute(
      "inputmode",
      "numeric"
    );
    expect(screen.getByRole("button", { name: "Authenticate with passkey" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use a recovery code" }));

    expect(await screen.findByRole("heading", { name: "Use a recovery code" })).toBeInTheDocument();
    const recoveryCodeInput = screen.getByPlaceholderText("Recovery code");
    expect(recoveryCodeInput).toHaveAttribute("inputmode", "text");
    expect(recoveryCodeInput).toHaveAttribute("autocomplete", "off");
    const recoveryForm = recoveryCodeInput.closest("form");
    expect(recoveryForm).not.toBeNull();
    expect(within(recoveryForm!).getByRole("button", { name: "Sign in" })).toBeDisabled();
    fireEvent.change(recoveryCodeInput, { target: { value: "A1B2C3D4E5" } });
    expect(within(recoveryForm!).getByRole("button", { name: "Sign in" })).toBeEnabled();
    fireEvent.click(
      within(recoveryForm!).getByRole("button", { name: "Back to authenticator code" })
    );

    expect(
      await screen.findByRole("heading", { name: "Two-factor authentication" })
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Authenticator code")).toBeInTheDocument();
  });

  it("lets a required-MFA account choose TOTP before showing the QR enrollment flow", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/auth/methods") {
        return Response.json({ oidc: false, password: true, emailOtp: false, passkeyLogin: false });
      }
      if (path === "/auth/email/continue") return Response.json({ method: "password" });
      if (path === "/auth/password/login") {
        return Response.json({
          ok: true,
          mfaEnrollmentRequired: true,
          enrollmentToken: "enrollment-token-1",
        });
      }
      if (path === "/auth/mfa/enrollment/totp/setup") {
        return Response.json({
          secret: "ABC123DEF456",
          uri: "otpauth://totp/Gateway:totp@example.com?secret=ABC123DEF456",
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    renderWithRouter(<LoginPage />, { path: "/login", route: "/login" });

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Email" }));
    fireEvent.change(await screen.findByPlaceholderText("Email"), {
      target: { value: "totp@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByPlaceholderText("Password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(
      await screen.findByRole("heading", { name: "Set up multi-factor authentication" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up authenticator app" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up passkey" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Set up authenticator app" }));

    expect(await screen.findByTitle("TOTP setup QR code")).toBeInTheDocument();
    expect(screen.getByText("Manual setup key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate TOTP" }).parentElement).toHaveClass(
      "flex",
      "gap-2"
    );
  });

  it("shows reset-link instructions after requesting a password reset", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/auth/methods") {
        return Response.json({ oidc: false, password: true, emailOtp: false, passkeyLogin: false });
      }
      if (path === "/auth/email/continue") return Response.json({ method: "password" });
      if (path === "/auth/password/reset/request") return Response.json({ ok: true });
      throw new Error(`Unexpected request: ${path}`);
    });

    renderWithRouter(<LoginPage />, { path: "/login", route: "/login" });

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Email" }));
    fireEvent.change(await screen.findByPlaceholderText("Email"), {
      target: { value: "reset@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const forgotPassword = await screen.findByRole("button", { name: "Forgot password?" });
    expect(forgotPassword).toHaveAttribute("data-button");
    expect(forgotPassword).toHaveClass("h-auto", "p-0");
    expect(screen.getByRole("link", { name: "Square Labs" })).toBeInTheDocument();
    fireEvent.click(forgotPassword);
    expect(await screen.findByRole("heading", { name: "Reset password?" })).toBeInTheDocument();
    expect(
      screen.getByText(/email a password-reset link to reset@example.com/i)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(screen.getByText(/password-reset link to reset@example.com/i)).toBeInTheDocument();
    expect(screen.getByText(/You can close this window/i)).toBeInTheDocument();
  });
});
