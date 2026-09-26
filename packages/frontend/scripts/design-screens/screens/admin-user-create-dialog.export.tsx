import { screen, within } from "@testing-library/react";
import { adminHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("admin-user-create-dialog", async () => {
  await exportScreen({
    id: "admin-user-create-dialog",
    title: "Users · Create User",
    group: "Administration",
    route: "/administration/users",
    handlers: adminHandlers(),
    height: 1000,
    ready: async () => {
      await screen.findByText("Priya Raman");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Create User" }));
      const dialog = await screen.findByRole("dialog");
      const [email, name] = within(dialog).getAllByRole("textbox");
      await user.type(email, "jonas.berg@example.com");
      if (name) await user.type(name, "Jonas Berg");
    },
  });
});
