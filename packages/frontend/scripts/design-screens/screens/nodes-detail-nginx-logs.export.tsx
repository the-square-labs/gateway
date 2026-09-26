import { screen } from "@testing-library/react";
import { nodeScreenHandlers, nodeScreenSetup } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-detail-nginx-logs", async () => {
  await exportScreen({
    id: "nodes-detail-nginx-logs",
    title: "Node · Nginx Logs",
    group: "Nodes",
    route: "/nodes/edge-fra-1/nginx-logs",
    handlers: nodeScreenHandlers(),
    before: nodeScreenSetup,
    height: 1100,
    ready: async () => {
      await screen.findByText("/wp-login.php");
    },
    notes: [
      "Live access and error log of the Frankfurt Ingress node (WebSocket stubbed with its first frame); legacy-admin answers 502.",
    ],
  });
});
