import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { databaseHandlers } from "../fixtures/data/database-handlers";
import { ordersDb, ordersMonitoringHistory } from "../fixtures/data/databases";
import { installFixtureEventSource } from "../fixtures/data/event-source";
import { giveHealthBarsDesktopWidth } from "../fixtures/data/layout";

it("database-detail", async () => {
  await exportScreen({
    id: "database-detail",
    title: "Database detail",
    group: "Screens",
    route: "/databases/orders-db",
    height: 1100,
    handlers: databaseHandlers(),
    before: () => {
      giveHealthBarsDesktopWidth();
      // The monitoring stream opens with the saved health and metric history.
      installFixtureEventSource((url) =>
        url.includes(`/databases/${ordersDb.id}/monitoring/stream`)
          ? {
              connected: { healthHistory: ordersDb.healthHistory, healthStatus: "online" },
              history: { history: ordersMonitoringHistory() },
            }
          : undefined
      );
    },
    ready: async () => {
      await screen.findByText("Transaction Rate");
      await screen.findByText(/TLS certificate expires/);
    },
    notes: [
      "Overview tab of a managed Postgres: metric history arrives through a fixture monitoring stream.",
      "Health bars get a desktop container width (jsdom has no layout), so they show ~13 h of 5-minute buckets.",
    ],
  });
});
