import { waitForPageText } from "../fixtures/data/ready";
import { settingsTabHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("admin-settings-environment", async () => {
  await exportScreen({
    id: "admin-settings-environment",
    title: "Settings · Environment",
    group: "Administration",
    route: "/settings/environment",
    handlers: settingsTabHandlers(),
    height: 1400,
    ready: async () => {
      await waitForPageText("Rate limits: core and authentication", "PKI defaults");
    },
  });
});
