import { act, screen } from "@testing-library/react";
import { useAuthStore } from "@/stores/auth";
import { adminUser } from "../fixtures/identity";
import { exportScreen } from "../harness";

it("signin-blocked", async () => {
  await exportScreen({
    id: "signin-blocked",
    title: "Access blocked",
    group: "Sign-in",
    route: "/blocked",
    before: () => {
      useAuthStore.setState({
        user: { ...adminUser, email: "sam.patel@example.com", name: "Sam Patel", isBlocked: true },
      });
    },
    // A standalone page outside the app layout: it has no reveal gate to wait for.
    captureBeforeReveal: async () => {
      await screen.findByText("Access Blocked", undefined, { timeout: 15_000 });
      await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    },
    notes: ["What a blocked account sees after signing in."],
  });
});
