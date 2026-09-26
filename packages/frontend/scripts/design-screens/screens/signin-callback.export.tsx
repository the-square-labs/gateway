import { screen } from "@testing-library/react";
import { useAuthStore } from "@/stores/auth";
import { mountLoginEntry, settle } from "../fixtures/signin/login-entry";
import { exportScreen } from "../harness";

it("signin-callback", async () => {
  await exportScreen({
    id: "signin-callback",
    title: "SSO callback",
    group: "Sign-in",
    route: "/callback",
    before: () => {
      useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
    },
    // The callback page is part of the sign-in entry (src/login-main.tsx) with no reveal gate.
    captureBeforeReveal: async () => {
      await mountLoginEntry();
      await screen.findAllByText("Authenticating...");
      await settle();
    },
    notes: [
      "Returning from the identity provider while the session is confirmed.",
      "The redirect into the console that follows is stubbed, so the page holds this state.",
    ],
  });
});
