import { waitForPageText } from "../fixtures/data/ready";
import { notificationsHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-notifications-siem", async () => {
  await exportScreen({
    id: "ops-notifications-siem",
    title: "Notifications · SIEM",
    group: "Observability",
    route: "/notifications/siem",
    handlers: notificationsHandlers(),
    ready: async () => {
      await waitForPageText("Security Operations", "Partner audit feed");
    },
  });
});
