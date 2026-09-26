import { screen } from "@testing-library/react";
import { detailSetup, webContainerHandlers } from "../fixtures/docker/detail-sets";
import { exportScreen } from "../harness";

it("docker-container-console", async () => {
  await exportScreen({
    id: "docker-container-console",
    title: "Container · Console",
    group: "Docker",
    route: "/docker/containers/apps-1/web/console",
    handlers: webContainerHandlers(),
    height: 1100,
    before: detailSetup,
    ready: async () => {
      await screen.findByText("Container Console");
    },
    placeholders: [
      { selector: ".terminal-console", label: "Terminal (xterm.js): interactive shell session" },
    ],
  });
});
