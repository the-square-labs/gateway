import { screen } from "@testing-library/react";
import { settingsHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("settings", async () => {
  await exportScreen({
    id: "settings",
    title: "Settings · General",
    group: "Administration",
    route: "/settings/general",
    handlers: settingsHandlers(),
    height: 1400,
    ready: async () => {
      await screen.findByText("Access and limits");
    },
  });
});
