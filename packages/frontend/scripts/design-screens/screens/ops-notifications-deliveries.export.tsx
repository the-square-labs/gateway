import { waitForPageText } from "../fixtures/data/ready";
import { notificationsHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-notifications-deliveries", async () => {
  await exportScreen({
    id: "ops-notifications-deliveries",
    title: "Notifications · Delivery Log",
    group: "Observability",
    route: "/notifications/deliveries",
    handlers: notificationsHandlers(),
    ready: async () => {
      await waitForPageText("certificate.days_until_expiry", "logging.error_fatal_ratio_percent");
    },
  });
});
