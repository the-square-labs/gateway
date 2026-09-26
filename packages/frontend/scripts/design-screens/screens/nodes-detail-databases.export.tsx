import { screen } from "@testing-library/react";
import { nodeScreenHandlers, nodeScreenSetup } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-detail-databases", async () => {
  await exportScreen({
    id: "nodes-detail-databases",
    title: "Node · Databases",
    group: "Nodes",
    route: "/nodes/db-1/databases",
    handlers: nodeScreenHandlers(),
    before: nodeScreenSetup,
    height: 1100,
    ready: async () => {
      await screen.findByText(/gw-db-sessions:6379/);
    },
  });
});
