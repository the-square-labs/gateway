import { screen } from "@testing-library/react";
import { detailSetup, webContainerHandlers } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-container-builds", async () => {
  await exportScreen({
    id: "docker-container-builds",
    title: "Container · Builds",
    group: "Docker",
    route: "/docker/containers/apps-1/web/builds",
    handlers: webContainerHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("Build history, security decisions, and deployment results.");
    },
  });
});
