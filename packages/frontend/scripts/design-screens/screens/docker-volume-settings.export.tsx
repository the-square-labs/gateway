import { screen } from "@testing-library/react";
import { detailSetup, webUploadsVolumeHandlers } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-volume-settings", async () => {
  await exportScreen({
    id: "docker-volume-settings",
    title: "Volume · Settings",
    group: "Docker",
    route: "/docker/volumes/apps-1/web-uploads/settings",
    handlers: webUploadsVolumeHandlers(),
    height: 1000,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("Attached containers");
    },
  });
});
