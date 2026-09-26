import { screen } from "@testing-library/react";
import { useResourceFolderStore } from "@/stores/resource-folders";
import { exportScreen } from "../harness";
import { adminHandlers } from "../fixtures/ops/handlers";

it("admin-groups", async () => {
  await exportScreen({
    id: "admin-groups",
    title: "Groups",
    group: "Administration",
    route: "/admin/groups",
    handlers: adminHandlers(),
    before: () => {
      // The operator keeps the Builtin folder open, so the built-in groups show next to custom ones.
      useResourceFolderStore.getState().toggleFolder("admin-group", "admin-groups-builtin");
    },
    ready: async () => {
      await screen.findByText("developers");
    },
  });
});
