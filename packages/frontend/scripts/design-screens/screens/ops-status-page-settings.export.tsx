import { waitForFieldValue } from "../fixtures/data/ready";
import { statusPageHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-status-page-settings", async () => {
  await exportScreen({
    id: "ops-status-page-settings",
    title: "Status Page · Settings",
    group: "Observability",
    route: "/status-page/settings",
    handlers: statusPageHandlers(),
    height: 1300,
    ready: async () => {
      await waitForFieldValue("Northwind Status");
    },
  });
});
