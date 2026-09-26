import { waitForFieldValue, waitForPageText } from "../fixtures/data/ready";
import { loggingHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-logging-schema", async () => {
  await exportScreen({
    id: "ops-logging-schema",
    title: "Logging schema",
    group: "Observability",
    route: "/logging/schemas/payment-audit",
    handlers: loggingHandlers(),
    ready: async () => {
      await waitForPageText("Payment audit", "Add Field");
      // Field keys are editable inputs.
      await waitForFieldValue("orderId");
    },
  });
});
