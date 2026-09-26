import { screen } from "@testing-library/react";
import { detailSetup, webContainerHandlers } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-container-settings", async () => {
  await exportScreen({
    id: "docker-container-settings",
    title: "Container · Settings",
    group: "Docker",
    route: "/docker/containers/apps-1/web/settings",
    handlers: webContainerHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("Restart Policy");
    },
  });
});
