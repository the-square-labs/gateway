/**
 * The sign-in pages live in their own entry (src/login-main.tsx), which the
 * exporter's app mount does not include: at /login, /reset-password and
 * /callback the console app only hands the document to that entry. This mounts
 * the same routes the entry mounts, next to the (empty) console app.
 */
import { act, render, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { ThemeProvider } from "@/components/layout/ThemeProvider";
import { AuthCallback } from "@/pages/AuthCallback";
import { type AuthMethods, LoginPage } from "@/pages/Login";
import { adminUser } from "../identity";

/** Every sign-in method enabled, as the server injects them into the login document. */
export const allAuthMethods: AuthMethods = {
  oidc: true,
  password: true,
  emailOtp: true,
  passkeyLogin: true,
  demoEmailOtp: false,
};

export const RESET_TOKEN = "fixture-reset-token";

export function signInHandlers() {
  return [
    http.get("*/auth/methods", () => HttpResponse.json(allAuthMethods)),
    http.post("*/auth/password/reset/profile", () =>
      HttpResponse.json({
        name: "Lena Novak",
        email: "lena.novak@example.com",
        avatarUrl: null,
        groupName: "operators",
      })
    ),
  ];
}

/** Waits for the console app to hand over (it renders nothing on sign-in routes). */
async function waitForConsoleHandover() {
  await waitFor(
    () => {
      if (document.querySelector('[aria-label="Loading application"]')) {
        throw new Error("console app still starting");
      }
    },
    { timeout: 15_000 }
  );
}

/** Mounts the login entry's routes at the current location. */
export async function mountLoginEntry(methods: AuthMethods = allAuthMethods) {
  await waitForConsoleHandover();
  render(
    <ErrorBoundary>
      <ThemeProvider>
        <BrowserRouter>
          <Routes>
            <Route
              path="/login"
              element={<LoginPage initialMethods={methods} onComplete={() => {}} />}
            />
            <Route
              path="/reset-password"
              element={<LoginPage initialMethods={methods} onComplete={() => {}} />}
            />
            <Route path="/callback" element={<AuthCallback onAuthenticated={() => {}} />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </BrowserRouter>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export const settle = (ms = 400) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

export { adminUser };
