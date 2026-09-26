import { screen } from "@testing-library/react";
import { detailSetup, webContainerHandlers } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-container-detail", async () => {
  await exportScreen({
    id: "docker-container-detail",
    title: "Container detail",
    group: "Docker",
    route: "/docker/containers/apps-1/web",
    handlers: webContainerHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("Port Mappings");
    },
  });
});
