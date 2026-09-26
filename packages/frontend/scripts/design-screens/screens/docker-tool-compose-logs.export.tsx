import { waitFor } from "@testing-library/react";
import { apps2 } from "../fixtures/docker/data";
import { installDockerStreams } from "../fixtures/docker/detail-sets";
import { pause } from "../fixtures/docker/ready";
import { exportScreen } from "../harness";

it("docker-tool-compose-logs", async () => {
  await exportScreen({
    id: "docker-tool-compose-logs",
    title: "Compose logs window",
    group: "Docker",
    route: `/docker/compose-logs/${apps2.id}/northwind-stack`,
    before: installDockerStreams,
    // Tool windows have no page reveal gate; capture once the log terminal mounted.
    captureBeforeReveal: async () => {
      await waitFor(() => {
        if (!document.querySelector("div.fixed.inset-0.bg-card"))
          throw new Error("terminal not mounted");
      });
      await pause();
    },
    placeholders: [
      {
        selector: "div.fixed.inset-0.bg-card",
        label: "Log terminal (xterm.js): aggregated northwind-stack service output",
      },
    ],
    notes: ["Popout window opened from the Compose project Logs tab; it fills the whole window."],
  });
});
