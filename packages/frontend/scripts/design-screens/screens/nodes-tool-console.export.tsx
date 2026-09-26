import { waitFor } from "@testing-library/react";
import { pause } from "../fixtures/docker/ready";
import { edgeNode } from "../fixtures/nodes";
import { installNodeStreams } from "../fixtures/nodes/node-tabs";
import { exportScreen } from "../harness";

it("nodes-tool-console", async () => {
  await exportScreen({
    id: "nodes-tool-console",
    title: "Node console window",
    group: "Nodes",
    route: `/nodes/console/${edgeNode.id}`,
    before: installNodeStreams,
    // Tool windows have no page reveal gate; capture once the terminal box mounted.
    captureBeforeReveal: async () => {
      await waitFor(() => {
        if (!document.querySelector(".terminal-console")) throw new Error("terminal not mounted");
      });
      await pause();
    },
    placeholders: [
      { selector: ".terminal-console", label: "Terminal (xterm.js): shell on edge-fra-1" },
    ],
    notes: ["Popout window opened from the node Console tab; it fills the whole window."],
  });
});
