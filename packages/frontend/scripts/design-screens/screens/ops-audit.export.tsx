import { waitForPageText } from "../fixtures/data/ready";
import { adminHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-audit", async () => {
  await exportScreen({
    id: "ops-audit",
    title: "Audit Log",
    group: "Observability",
    route: "/audit",
    handlers: adminHandlers(),
    ready: async () => {
      await waitForPageText("Priya Raman", "Container restart loop");
    },
    notes: [
      "/audit redirects to Administration · Audit Log (/administration/audit); this is that tab.",
    ],
  });
});
