import { screen } from "@testing-library/react";
import { detailSetup, webContainerHandlers } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-container-stats", async () => {
  await exportScreen({
    id: "docker-container-stats",
    title: "Container · Monitoring",
    group: "Docker",
    route: "/docker/containers/apps-1/web/stats",
    handlers: webContainerHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findAllByText("nginx: worker process");
    },
  });
});
