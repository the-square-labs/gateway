import { screen } from "@testing-library/react";
import { detailSetup, webContainerHandlers } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-container-environment", async () => {
  await exportScreen({
    id: "docker-container-environment",
    title: "Container · Environment",
    group: "Docker",
    route: "/docker/containers/apps-1/web/environment",
    handlers: webContainerHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByDisplayValue("SESSION_SECRET");
    },
  });
});
