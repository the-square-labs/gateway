import { screen, within } from "@testing-library/react";
import { databaseHandlers, managedNodeHandlers } from "../fixtures/data/database-handlers";
import { databaseFolders } from "../fixtures/data/databases";
import { expandFolders } from "../fixtures/data/folders";
import { exportScreen } from "../harness";

it("data-database-deploy-dialog", async () => {
  await exportScreen({
    id: "data-database-deploy-dialog",
    title: "Databases · Deploy Managed Database",
    group: "Data",
    route: "/databases",
    handlers: [...managedNodeHandlers(), ...databaseHandlers()],
    height: 1000,
    before: () => {
      expandFolders(
        "database",
        databaseFolders.map((folder) => folder.id)
      );
    },
    ready: async () => {
      await screen.findByText("events-warehouse");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Deploy database" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getAllByRole("textbox")[0], "inventory-db");
      const nodePicker = within(dialog)
        .getAllByRole("combobox")
        .find((element) => element.textContent?.includes("Select node"));
      if (nodePicker) {
        await user.click(nodePicker);
        await user.click(await screen.findByRole("option", { name: /db-1|Database host/ }));
      }
    },
    notes: ["Step 1 of the managed database wizard, opened from the Databases list."],
  });
});
