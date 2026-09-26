import { screen } from "@testing-library/react";
import { nodeScreenHandlers, nodeScreenSetup } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("node-detail", async () => {
  await exportScreen({
    id: "node-detail",
    title: "Node detail",
    group: "Nodes",
    route: "/nodes/edge-fra-1",
    handlers: nodeScreenHandlers(),
    before: nodeScreenSetup,
    height: 1300,
    ready: async () => {
      await screen.findByText("Assigned Routes");
      await screen.findByText("grafana.example.com");
    },
    notes: [
      "Overview tab of the Frankfurt Ingress node; the CPU/memory/traffic charts live on the Monitoring tab.",
    ],
  });
});
