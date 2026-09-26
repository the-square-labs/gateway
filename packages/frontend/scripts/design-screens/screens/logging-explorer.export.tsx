import { screen } from "@testing-library/react";
import { loggingHandlers } from "../fixtures/ops/handlers";
import { installVirtualTableLayout } from "../fixtures/ops/virtual-layout";
import { exportScreen } from "../harness";

it("logging-explorer", async () => {
  const restoreLayout = installVirtualTableLayout();
  try {
    await exportScreen({
      id: "logging-explorer",
      title: "Logging environment · Logs",
      group: "Observability",
      route: "/logging/environments/production/logs",
      handlers: loggingHandlers(),
      ready: async () => {
        await screen.findByText("POST /v1/orders 201 in 84 ms");
        await screen.findByText("Retrying webhook delivery to fulfillment (attempt 2 of 5)");
      },
      notes: [
        "Log rows come from the real virtualized DataTable; jsdom has no layout, so the export gives its scroll container the viewport height and each row the table's own 49px row estimate.",
      ],
    });
  } finally {
    restoreLayout();
  }
});
