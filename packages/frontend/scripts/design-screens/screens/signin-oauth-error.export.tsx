import { act, screen } from "@testing-library/react";
import { exportScreen } from "../harness";

it("signin-oauth-error", async () => {
  await exportScreen({
    id: "signin-oauth-error",
    title: "OAuth error",
    group: "Sign-in",
    route:
      "/oauth/error?code=INVALID_REDIRECT_URI&message=The%20redirect%20URI%20is%20not%20registered%20for%20this%20client.",
    // A standalone page outside the app layout: it has no reveal gate to wait for.
    captureBeforeReveal: async () => {
      await screen.findByText("OAuth authorization failed", undefined, { timeout: 15_000 });
      await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    },
    notes: ["Shown when an OAuth authorization request cannot be completed."],
  });
});
