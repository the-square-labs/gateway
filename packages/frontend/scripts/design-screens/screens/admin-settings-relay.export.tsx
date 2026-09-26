import { waitForPageText } from "../fixtures/data/ready";
import { settingsTabHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("admin-settings-relay", async () => {
  await exportScreen({
    id: "admin-settings-relay",
    title: "Settings · Relay",
    group: "Administration",
    route: "/settings/relay",
    handlers: settingsTabHandlers(),
    height: 1400,
    ready: async () => {
      await waitForPageText("edge-ams-1 relay", "Tunnel activity");
    },
  });
});
