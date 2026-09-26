import { waitForPageText } from "../fixtures/data/ready";
import { statusPageHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-status-page-incidents", async () => {
  await exportScreen({
    id: "ops-status-page-incidents",
    title: "Status Page · Incidents",
    group: "Observability",
    route: "/status-page/incidents",
    handlers: statusPageHandlers(),
    ready: async () => {
      await waitForPageText("Dashboards responding slowly", "Payment API errors");
    },
  });
});
