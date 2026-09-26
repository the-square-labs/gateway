import { screen } from "@testing-library/react";
import { useAuthStore } from "@/stores/auth";
import { mountLoginEntry, settle } from "../fixtures/signin/login-entry";
import { exportScreen } from "../harness";

it("signin-callback-error", async () => {
  await exportScreen({
    id: "signin-callback-error",
    title: "SSO callback · Failed",
    group: "Sign-in",
    route: "/callback?error=The%20identity%20provider%20denied%20the%20sign-in%20request.",
    before: () => {
      useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
    },
    // The callback page is part of the sign-in entry (src/login-main.tsx) with no reveal gate.
    captureBeforeReveal: async () => {
      await mountLoginEntry();
      await screen.findByText("Authentication Failed");
      await settle();
    },
    notes: ["The identity provider returned an error to the callback."],
  });
});
