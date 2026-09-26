import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { notificationsHandlers } from "../fixtures/ops/handlers";

it("notifications-alerts", async () => {
  await exportScreen({
    id: "notifications-alerts",
    title: "Notifications · Alerts",
    group: "Screens",
    route: "/notifications/alerts",
    handlers: notificationsHandlers(),
    ready: async () => {
      await screen.findByText("Container restart loop");
    },
  });
});
