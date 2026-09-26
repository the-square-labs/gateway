import { waitForPageText } from "../fixtures/data/ready";
import { adminHandlers, settingsTabHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("admin-settings-inference", async () => {
  await exportScreen({
    id: "admin-settings-inference",
    title: "Settings · Inference",
    group: "Administration",
    route: "/settings/inference",
    handlers: [...settingsTabHandlers(), ...adminHandlers()],
    height: 1400,
    ready: async () => {
      await waitForPageText("GPU box (apps-2)", "Recent activity");
    },
  });
});
