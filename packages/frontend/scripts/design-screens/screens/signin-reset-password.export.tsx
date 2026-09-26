import { screen } from "@testing-library/react";
import { useAuthStore } from "@/stores/auth";
import {
  mountLoginEntry,
  RESET_TOKEN,
  settle,
  signInHandlers,
} from "../fixtures/signin/login-entry";
import { exportScreen } from "../harness";

it("signin-reset-password", async () => {
  await exportScreen({
    id: "signin-reset-password",
    title: "Reset password",
    group: "Sign-in",
    route: `/reset-password?token=${RESET_TOKEN}`,
    handlers: signInHandlers(),
    before: () => {
      useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
    },
    // The sign-in page is its own entry (src/login-main.tsx) with no reveal gate.
    captureBeforeReveal: async () => {
      await mountLoginEntry();
      await screen.findByText("lena.novak@example.com");
      await settle();
    },
    notes: [
      "Opened from a password-reset link: the account is confirmed before a new password is set.",
    ],
  });
});
