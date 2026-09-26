import { apps1 } from "../fixtures/docker/data";
import { pause, waitForText } from "../fixtures/docker/ready";
import { dockerToolHandlers } from "../fixtures/docker/tools";
import { exportScreen } from "../harness";

it("docker-tool-volume-file", async () => {
  await exportScreen({
    id: "docker-tool-volume-file",
    title: "Volume file editor",
    group: "Docker",
    route: `/docker/volume-file/${apps1.id}/web-uploads?path=%2Fcatalog-export.json&writable=1`,
    handlers: dockerToolHandlers(),
    // Tool windows have no page reveal gate; capture once the file is open.
    captureBeforeReveal: async () => {
      await waitForText("catalog-export.json");
      await pause();
    },
    placeholders: [
      { selector: ".cm-editor", label: "File editor (CodeMirror): catalog export JSON" },
    ],
    notes: [
      "Popout window opened from the volume Files tab: /catalog-export.json in web-uploads, editable.",
    ],
  });
});
