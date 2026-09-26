import { screen } from "@testing-library/react";
import { detailSetup, webUploadsVolumeHandlers } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-volume-files", async () => {
  await exportScreen({
    id: "docker-volume-files",
    title: "Volume · Files",
    group: "Docker",
    route: "/docker/volumes/apps-1/web-uploads/files",
    handlers: webUploadsVolumeHandlers(),
    height: 1000,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("avatars");
    },
  });
});
