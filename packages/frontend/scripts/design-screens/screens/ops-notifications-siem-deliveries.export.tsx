import { waitForPageText } from "../fixtures/data/ready";
import { notificationsHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-notifications-siem-deliveries", async () => {
  await exportScreen({
    id: "ops-notifications-siem-deliveries",
    title: "Notifications · SIEM Delivery Log",
    group: "Observability",
    route: "/notifications/siem-deliveries",
    handlers: notificationsHandlers(),
    ready: async () => {
      await waitForPageText("database.backup.run", "Compliance archive");
    },
  });
});
