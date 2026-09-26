import { screen } from "@testing-library/react";
import { detailSetup, webContainerHandlers } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-container-source", async () => {
  await exportScreen({
    id: "docker-container-source",
    title: "Container · Source",
    group: "Docker",
    route: "/docker/containers/apps-1/web/source",
    handlers: webContainerHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("Dockerfile");
    },
  });
});
