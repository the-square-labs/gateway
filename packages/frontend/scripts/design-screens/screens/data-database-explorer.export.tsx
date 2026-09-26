import { installOrdersStreams, ordersDetailHandlers } from "../fixtures/data/database-detail";
import { waitForFieldValue } from "../fixtures/data/ready";
import { installVirtualListLayout } from "../fixtures/data/virtual-list";
import { exportScreen } from "../harness";

it("data-database-explorer", async () => {
  await exportScreen({
    id: "data-database-explorer",
    title: "Database · Explorer",
    group: "Data",
    route: "/databases/orders-db/explorer",
    handlers: ordersDetailHandlers(),
    before: () => {
      installOrdersStreams();
      // The explorer grid virtualizes its rows (37px each, the grid's own estimate).
      installVirtualListLayout({
        container: "div.dashboard-scrollbar.overflow-auto",
        rowHeight: 37,
      });
    },
    ready: async () => {
      // Grid cells are inputs (the grid is editable), so wait for a cell value.
      await waitForFieldValue("NW-48213");
    },
    notes: [
      "Postgres explorer of orders-db on the public.orders table; the virtualized grid gets a desktop height (jsdom has no layout).",
    ],
  });
});
