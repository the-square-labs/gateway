import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { installOrdersStreams, ordersDetailHandlers } from "../fixtures/data/database-detail";
import { waitForFieldValue } from "../fixtures/data/ready";
import { installVirtualListLayout } from "../fixtures/data/virtual-list";
import { exportScreen } from "../harness";

it("data-database-explorer-dialog-column-types", async () => {
  await exportScreen({
    id: "data-database-explorer-dialog-column-types",
    title: "Database · Explorer · Column Types",
    group: "Data",
    route: "/databases/orders-db/explorer",
    handlers: ordersDetailHandlers(),
    height: 1000,
    before: () => {
      installOrdersStreams();
      installVirtualListLayout({
        container: "div.dashboard-scrollbar.overflow-auto",
        rowHeight: 37,
      });
    },
    ready: async () => {
      await waitForFieldValue("NW-48213");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Column types" }));
      const dialog = await screen.findByRole("dialog", { name: "Column Types" });
      await within(dialog).findByText("customer_email");
      await waitForReveal();
      // One pending column, so the editable rows and the Save count show.
      await user.click(within(dialog).getByRole("button", { name: "Add column" }));
      await user.type(
        within(dialog).getByRole("textbox", { name: "New column name" }),
        "gift_message"
      );
    },
    notes: ["Column types of public.orders for a database admin, with one pending new column."],
  });
});
