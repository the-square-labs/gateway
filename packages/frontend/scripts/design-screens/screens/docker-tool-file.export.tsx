import { webContainerId } from "../fixtures/docker/container-detail";
import { apps1 } from "../fixtures/docker/data";
import { pause, waitForText } from "../fixtures/docker/ready";
import { dockerToolHandlers } from "../fixtures/docker/tools";
import { exportScreen } from "../harness";

it("docker-tool-file", async () => {
  await exportScreen({
    id: "docker-tool-file",
    title: "Container file editor",
    group: "Docker",
    route: `/docker/file/${apps1.id}/${webContainerId}?path=%2Fetc%2Fnginx%2Fconf.d%2Fdefault.conf&writable=1`,
    handlers: dockerToolHandlers(),
    // Tool windows have no page reveal gate; capture once the file is open.
    captureBeforeReveal: async () => {
      await waitForText("default.conf");
      await pause();
    },
    placeholders: [
      { selector: ".cm-editor", label: "File editor (CodeMirror): nginx server block" },
    ],
    notes: [
      "Popout window opened from the container Files tab: /etc/nginx/conf.d/default.conf, editable.",
    ],
  });
});
