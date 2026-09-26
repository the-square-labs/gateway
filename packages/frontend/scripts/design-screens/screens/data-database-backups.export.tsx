import { screen } from "@testing-library/react";
import { installOrdersStreams, ordersDetailHandlers } from "../fixtures/data/database-detail";
import { exportScreen } from "../harness";

it("data-database-backups", async () => {
  await exportScreen({
    id: "data-database-backups",
    title: "Database · Backups",
    group: "Data",
    route: "/databases/orders-db/backups",
    handlers: ordersDetailHandlers(),
    height: 1200,
    before: installOrdersStreams,
    ready: async () => {
      await screen.findByText(/Schedule 0 2 \* \* \*/);
      await screen.findByText(/Upload to db-backups timed out/);
    },
  });
});
