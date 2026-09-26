import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { settingsHandlers } from "../fixtures/ops/handlers";

it("settings", async () => {
  await exportScreen({
    id: "settings",
    title: "Settings",
    group: "Screens",
    route: "/settings/general",
    handlers: settingsHandlers(),
    height: 1400,
    ready: async () => {
      await screen.findByText("Access and limits");
    },
  });
});
