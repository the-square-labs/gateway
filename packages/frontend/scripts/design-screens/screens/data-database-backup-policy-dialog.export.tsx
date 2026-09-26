import { screen, within } from "@testing-library/react";
import { installOrdersStreams, ordersDetailHandlers } from "../fixtures/data/database-detail";
import { exportScreen } from "../harness";

it("data-database-backup-policy-dialog", async () => {
  await exportScreen({
    id: "data-database-backup-policy-dialog",
    title: "Database · Add Backup Policy",
    group: "Data",
    route: "/databases/orders-db/backups",
    handlers: ordersDetailHandlers(),
    height: 1100,
    before: installOrdersStreams,
    ready: async () => {
      await screen.findByText(/Schedule 0 2 \* \* \*/);
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Add policy" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("Bucket"), "db-backups");
      const prefix = within(dialog).getByLabelText("Prefix");
      await user.clear(prefix);
      await user.type(prefix, "orders-db/weekly");
      await user.click(within(dialog).getByRole("combobox", { name: "Storage" }));
      await user.click(await screen.findByRole("option", { name: "backups" }));
      await user.click(within(dialog).getByRole("combobox", { name: "Storage node" }));
      await user.click(await screen.findByRole("option", { name: "storage-1" }));
      // The timezone defaults to the browser's own zone; the board shows the team's zone instead.
      const timezone = within(dialog).getByLabelText("Timezone");
      await user.clear(timezone);
      await user.type(timezone, "Europe/Berlin");
    },
  });
});
