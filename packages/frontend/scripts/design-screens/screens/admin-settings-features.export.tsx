import { waitForPageText } from "../fixtures/data/ready";
import { settingsTabHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("admin-settings-features", async () => {
  await exportScreen({
    id: "admin-settings-features",
    title: "Settings · Features",
    group: "Administration",
    route: "/settings/features",
    handlers: settingsTabHandlers(),
    height: 2000,
    ready: async () => {
      await waitForPageText("Last run 20h ago", "status.example.com");
    },
  });
});
