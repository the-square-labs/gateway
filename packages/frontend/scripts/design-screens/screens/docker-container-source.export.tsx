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
    height: 1450,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("Dockerfile");
    },
    notes: [
      "Repository (where the code comes from, when it builds) and Build (how it is built, checked and rolled out) sit side by side; each saves its own settings.",
      "Sync now checks the branch for new commits right away; Disconnect lives in Destructive actions at the bottom.",
    ],
  });
});
