import { waitForPageText } from "../fixtures/data/ready";
import { loggingHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-logging-environments", async () => {
  await exportScreen({
    id: "ops-logging-environments",
    title: "Logging · Environments",
    group: "Observability",
    route: "/logging",
    handlers: loggingHandlers(),
    ready: async () => {
      await waitForPageText("Payments sandbox", "Edge access");
    },
  });
});
