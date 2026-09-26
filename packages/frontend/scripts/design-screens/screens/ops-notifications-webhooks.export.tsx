import { waitForPageText } from "../fixtures/data/ready";
import { notificationsHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-notifications-webhooks", async () => {
  await exportScreen({
    id: "ops-notifications-webhooks",
    title: "Notifications · Webhooks",
    group: "Observability",
    route: "/notifications/webhooks",
    handlers: notificationsHandlers(),
    ready: async () => {
      await waitForPageText("On-call pager", "Platform Discord");
    },
  });
});
