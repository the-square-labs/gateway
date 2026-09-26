import { waitForPageText } from "../fixtures/data/ready";
import { settingsTabHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("admin-settings-integrations", async () => {
  await exportScreen({
    id: "admin-settings-integrations",
    title: "Settings · Integrations",
    group: "Administration",
    route: "/settings/integrations",
    handlers: settingsTabHandlers(),
    height: 1400,
    ready: async () => {
      await waitForPageText("Northwind GitLab", "Legacy CRM host");
    },
  });
});
