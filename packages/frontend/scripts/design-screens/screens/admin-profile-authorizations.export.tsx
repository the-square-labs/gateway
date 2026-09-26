import { useAuthStore } from "@/stores/auth";
import { waitForPageText } from "../fixtures/data/ready";
import { adminHandlers, profileHandlers } from "../fixtures/ops/handlers";
import { localAccountUser } from "../fixtures/ops/profile";
import { exportScreen } from "../harness";

it("admin-profile-authorizations", async () => {
  await exportScreen({
    id: "admin-profile-authorizations",
    title: "Profile · Authorizations",
    group: "Administration",
    route: "/profile/authorizations",
    handlers: [...profileHandlers(), ...adminHandlers()],
    height: 1300,
    before: () => {
      useAuthStore.setState({ user: localAccountUser, isAuthenticated: true, isLoading: false });
    },
    ready: async () => {
      await waitForPageText("Desktop assistant (MCP)", "Laptop (Codex)");
    },
  });
});
