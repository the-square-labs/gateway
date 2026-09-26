import { screen } from "@testing-library/react";
import { nodeScreenHandlers, nodeScreenSetup } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-detail-console", async () => {
  await exportScreen({
    id: "nodes-detail-console",
    title: "Node · Console",
    group: "Nodes",
    route: "/nodes/edge-fra-1/console",
    handlers: nodeScreenHandlers(),
    before: nodeScreenSetup,
    height: 1100,
    ready: async () => {
      await screen.findByText("Node Console");
    },
    placeholders: [
      { selector: ".terminal-console", label: "Terminal (xterm.js): shell on edge-fra-1" },
    ],
  });
});
