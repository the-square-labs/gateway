import { screen } from "@testing-library/react";
import { nodeScreenHandlers, nodeScreenSetup } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-detail-configuration", async () => {
  await exportScreen({
    id: "nodes-detail-configuration",
    title: "Node · Configuration",
    group: "Nodes",
    route: "/nodes/edge-fra-1/configuration",
    handlers: nodeScreenHandlers(),
    before: nodeScreenSetup,
    height: 1100,
    ready: async () => {
      await screen.findByText("Nginx Config");
    },
    placeholders: [
      { selector: ".cm-editor", label: "Nginx config editor (CodeMirror): /etc/nginx/nginx.conf" },
    ],
  });
});
