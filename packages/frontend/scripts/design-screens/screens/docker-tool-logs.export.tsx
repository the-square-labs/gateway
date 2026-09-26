import { webContainerId } from "../fixtures/docker/container-detail";
import { apps1 } from "../fixtures/docker/data";
import { installDockerStreams } from "../fixtures/docker/detail-sets";
import { giveLogViewportHeight } from "../fixtures/docker/jsdom-shims";
import { pause, waitForText } from "../fixtures/docker/ready";
import { exportScreen } from "../harness";

it("docker-tool-logs", async () => {
  await exportScreen({
    id: "docker-tool-logs",
    title: "Container logs window",
    group: "Docker",
    route: `/docker/logs/${apps1.id}/${webContainerId}`,
    before: () => {
      giveLogViewportHeight();
      installDockerStreams();
    },
    // Tool windows have no page reveal gate; capture once the stream delivered its lines.
    captureBeforeReveal: async () => {
      await waitForText("Configuration complete");
      await pause();
    },
    notes: ["Popout window opened from the container Logs tab: the live log stream of web."],
  });
});
