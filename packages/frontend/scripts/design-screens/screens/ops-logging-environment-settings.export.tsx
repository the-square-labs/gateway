import { waitForPageText } from "../fixtures/data/ready";
import { loggingHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-logging-environment-settings", async () => {
  await exportScreen({
    id: "ops-logging-environment-settings",
    title: "Logging environment · Settings",
    group: "Observability",
    route: "/logging/environments/production/settings",
    handlers: loggingHandlers(),
    ready: async () => {
      await waitForPageText("Attached schema", "Service events");
    },
  });
});
