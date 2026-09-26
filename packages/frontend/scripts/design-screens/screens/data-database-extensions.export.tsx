import { screen } from "@testing-library/react";
import { installOrdersStreams, ordersDetailHandlers } from "../fixtures/data/database-detail";
import { exportScreen } from "../harness";

it("data-database-extensions", async () => {
  await exportScreen({
    id: "data-database-extensions",
    title: "Database · Extensions",
    group: "Data",
    route: "/databases/orders-db/extensions",
    handlers: ordersDetailHandlers(),
    before: installOrdersStreams,
    ready: async () => {
      await screen.findByText("pg_stat_statements");
    },
  });
});
