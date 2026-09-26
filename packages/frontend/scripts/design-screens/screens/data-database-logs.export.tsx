import { installOrdersStreams, ordersDetailHandlers } from "../fixtures/data/database-detail";
import { waitForPageText } from "../fixtures/data/ready";
import { installVirtualListLayout } from "../fixtures/data/virtual-list";
import { exportScreen } from "../harness";

it("data-database-logs", async () => {
  await exportScreen({
    id: "data-database-logs",
    title: "Database · Logs",
    group: "Data",
    route: "/databases/orders-db/logs",
    handlers: ordersDetailHandlers(),
    before: () => {
      installOrdersStreams();
      // The log viewport virtualizes its lines (18px each, the list's own estimate).
      installVirtualListLayout({ container: "div.overflow-auto.bg-card.py-4", rowHeight: 20 });
    },
    ready: async () => {
      // Log lines are split into ANSI-coloured spans, so match on the page text.
      await waitForPageText("idle-in-transaction timeout");
    },
    notes: [
      "The log tail arrives through a fixture WebSocket that sends the stream's initial frame.",
    ],
  });
});
