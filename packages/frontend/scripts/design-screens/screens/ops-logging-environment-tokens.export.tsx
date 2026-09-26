import { waitForPageText } from "../fixtures/data/ready";
import { loggingHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-logging-environment-tokens", async () => {
  await exportScreen({
    id: "ops-logging-environment-tokens",
    title: "Logging environment · Tokens",
    group: "Observability",
    route: "/logging/environments/production/tokens",
    handlers: loggingHandlers(),
    ready: async () => {
      await waitForPageText("edge-forwarder", "worker");
    },
  });
});
