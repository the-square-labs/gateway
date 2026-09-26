import { screen } from "@testing-library/react";
import { useAuthStore } from "@/stores/auth";
import { exportScreen } from "../harness";
import { profileHandlers } from "../fixtures/ops/handlers";
import { localAccountUser } from "../fixtures/ops/profile";

it("profile", async () => {
  await exportScreen({
    id: "profile",
    title: "Profile",
    group: "Screens",
    route: "/profile",
    handlers: profileHandlers(),
    height: 1300,
    before: () => {
      useAuthStore.setState({ user: localAccountUser, isAuthenticated: true, isLoading: false });
    },
    ready: async () => {
      await screen.findByText("Account security");
      await screen.findByText("8 recovery codes remain");
    },
    notes: [
      "Maya signs in with a local password account here: the Account security panel (passkeys, authenticator app) only shows for non-OIDC users.",
    ],
  });
});
