import { waitForPageText } from "../fixtures/data/ready";
import { statusPageHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-status-page-services", async () => {
  await exportScreen({
    id: "ops-status-page-services",
    title: "Status Page · Exposed Services",
    group: "Observability",
    route: "/status-page",
    handlers: statusPageHandlers(),
    ready: async () => {
      await waitForPageText("Dashboards", "Background jobs");
    },
  });
});
