import { waitForPageText } from "../fixtures/data/ready";
import { settingsTabHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("admin-settings-ai", async () => {
  await exportScreen({
    id: "admin-settings-ai",
    title: "Settings · AI Workspace",
    group: "Administration",
    route: "/settings/ai",
    handlers: settingsTabHandlers(),
    height: 1400,
    ready: async () => {
      await waitForPageText("route-latency-report.md", "Sandbox Runner");
    },
  });
});
