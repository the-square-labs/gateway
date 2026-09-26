import { screen, within } from "@testing-library/react";
import { useAuthStore } from "@/stores/auth";
import { waitForPageText } from "../fixtures/data/ready";
import { adminHandlers, profileHandlers, scopePickerHandlers } from "../fixtures/ops/handlers";
import { localAccountUser } from "../fixtures/ops/profile";
import { exportScreen } from "../harness";

it("admin-api-token-dialog", async () => {
  await exportScreen({
    id: "admin-api-token-dialog",
    title: "Profile · Create API Token",
    group: "Administration",
    route: "/profile/authorizations",
    handlers: [...profileHandlers(), ...adminHandlers(), ...scopePickerHandlers()],
    height: 1100,
    before: () => {
      useAuthStore.setState({ user: localAccountUser, isAuthenticated: true, isLoading: false });
    },
    ready: async () => {
      await waitForPageText("CI deploys (storefront)");
    },
    interact: async (user) => {
      await user.click(screen.getAllByRole("button", { name: "Create Token" })[0]);
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getAllByRole("textbox")[0], "Release pipeline");
    },
  });
});
