import { screen, within } from "@testing-library/react";
import { useResourceFolderStore } from "@/stores/resource-folders";
import { adminHandlers, scopePickerHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("admin-group-create-dialog", async () => {
  await exportScreen({
    id: "admin-group-create-dialog",
    title: "Groups · Create Group",
    group: "Administration",
    route: "/administration/groups",
    handlers: [...adminHandlers(), ...scopePickerHandlers()],
    height: 1100,
    before: () => {
      useResourceFolderStore.getState().toggleFolder("admin-group", "admin-groups-builtin");
    },
    ready: async () => {
      await screen.findByText("developers");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Create Group" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getAllByRole("textbox")[0], "support");
    },
  });
});
