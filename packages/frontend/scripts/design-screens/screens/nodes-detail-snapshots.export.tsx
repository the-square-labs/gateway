import { screen } from "@testing-library/react";
import { nodeScreenHandlers, nodeScreenSetup } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-detail-snapshots", async () => {
  await exportScreen({
    id: "nodes-detail-snapshots",
    title: "Node · Snapshots",
    group: "Nodes",
    route: "/nodes/apps-2/snapshots",
    handlers: nodeScreenHandlers(),
    before: nodeScreenSetup,
    height: 1100,
    ready: async () => {
      await screen.findByText("before-stack-rc2");
    },
  });
});
