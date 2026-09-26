import { screen } from "@testing-library/react";
import { detailSetup, webContainerHandlers } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-container-files", async () => {
  await exportScreen({
    id: "docker-container-files",
    title: "Container · Files",
    group: "Docker",
    route: "/docker/containers/apps-1/web/files",
    handlers: webContainerHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("docker-entrypoint.sh");
    },
  });
});
