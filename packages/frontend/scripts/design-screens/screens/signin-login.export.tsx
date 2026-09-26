import { screen } from "@testing-library/react";
import { useAuthStore } from "@/stores/auth";
import { mountLoginEntry, settle, signInHandlers } from "../fixtures/signin/login-entry";
import { exportScreen } from "../harness";

it("signin-login", async () => {
  await exportScreen({
    id: "signin-login",
    title: "Sign in",
    group: "Sign-in",
    route: "/login",
    handlers: signInHandlers(),
    before: () => {
      useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
    },
    // The sign-in page is its own entry (src/login-main.tsx) with no reveal gate.
    captureBeforeReveal: async () => {
      await mountLoginEntry();
      await screen.findByText("Infrastructure control plane");
      await settle();
    },
    notes: ["Sign-in with SSO, email (password or one-time code) and passkeys all enabled."],
  });
});
