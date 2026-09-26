import { waitFor } from "@testing-library/react";
import { webContainerId } from "../fixtures/docker/container-detail";
import { apps1 } from "../fixtures/docker/data";
import { installDockerStreams } from "../fixtures/docker/detail-sets";
import { pause } from "../fixtures/docker/ready";
import { exportScreen } from "../harness";

it("docker-tool-console", async () => {
  await exportScreen({
    id: "docker-tool-console",
    title: "Container console window",
    group: "Docker",
    route: `/docker/console/${apps1.id}/${webContainerId}`,
    before: installDockerStreams,
    // Tool windows have no page reveal gate; capture once the terminal box mounted.
    captureBeforeReveal: async () => {
      await waitFor(() => {
        if (!document.querySelector(".terminal-console")) throw new Error("terminal not mounted");
      });
      await pause();
    },
    placeholders: [
      { selector: ".terminal-console", label: "Terminal (xterm.js): shell in the web container" },
    ],
    notes: ["Popout window opened from the container Console tab; it fills the whole window."],
  });
});
