import { screen } from "@testing-library/react";
import { nodeScreenHandlers, nodeScreenSetup } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-detail-monitoring", async () => {
  await exportScreen({
    id: "nodes-detail-monitoring",
    title: "Node · Monitoring",
    group: "Nodes",
    route: "/nodes/edge-fra-1/monitoring",
    handlers: nodeScreenHandlers(),
    before: nodeScreenSetup,
    height: 1100,
    ready: async () => {
      await screen.findByText("System Resources");
    },
  });
});
