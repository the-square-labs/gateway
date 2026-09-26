import { screen } from "@testing-library/react";
import { nodeScreenHandlers, nodeScreenSetup } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-detail-files", async () => {
  await exportScreen({
    id: "nodes-detail-files",
    title: "Node · Files",
    group: "Nodes",
    route: "/nodes/edge-fra-1/files",
    handlers: nodeScreenHandlers(),
    before: nodeScreenSetup,
    height: 1100,
    ready: async () => {
      await screen.findByText("boot");
    },
  });
});
