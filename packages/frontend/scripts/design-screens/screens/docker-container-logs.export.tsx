import { screen } from "@testing-library/react";
import { detailSetup, webContainerHandlers } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-container-logs", async () => {
  await exportScreen({
    id: "docker-container-logs",
    title: "Container · Logs",
    group: "Docker",
    route: "/docker/containers/apps-1/web/logs",
    handlers: webContainerHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText(/Configuration complete/);
    },
  });
});
