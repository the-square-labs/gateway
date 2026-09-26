import { pause, waitForText } from "../fixtures/docker/ready";
import { dockerToolHandlers } from "../fixtures/docker/tools";
import { edgeNode } from "../fixtures/nodes";
import { exportScreen } from "../harness";

it("nodes-tool-file", async () => {
  await exportScreen({
    id: "nodes-tool-file",
    title: "Node file editor",
    group: "Nodes",
    route: `/nodes/file/${edgeNode.id}?path=%2Fetc%2Fnginx%2Fnginx.conf&writable=1`,
    handlers: dockerToolHandlers(),
    // Tool windows have no page reveal gate; capture once the file is open.
    captureBeforeReveal: async () => {
      await waitForText("nginx.conf");
      await pause();
    },
    placeholders: [
      { selector: ".cm-editor", label: "File editor (CodeMirror): /etc/nginx/nginx.conf" },
    ],
    notes: ["Popout window opened from the node Files tab: nginx.conf on edge-fra-1, editable."],
  });
});
