import { waitForPageText } from "../fixtures/data/ready";
import { loggingHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-logging-schemas", async () => {
  await exportScreen({
    id: "ops-logging-schemas",
    title: "Logging · Schemas",
    group: "Observability",
    route: "/logging/schemas",
    handlers: loggingHandlers(),
    ready: async () => {
      await waitForPageText("Payment audit", "Service events");
    },
  });
});
