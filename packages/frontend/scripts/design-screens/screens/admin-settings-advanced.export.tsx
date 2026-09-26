import { waitForPageText } from "../fixtures/data/ready";
import { settingsTabHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("admin-settings-advanced", async () => {
  await exportScreen({
    id: "admin-settings-advanced",
    title: "Settings · Advanced",
    group: "Administration",
    route: "/settings/advanced",
    handlers: settingsTabHandlers(),
    height: 1400,
    ready: async () => {
      await waitForPageText("Northwind registry", "Docker Hub mirror (apps-1)");
    },
  });
});
