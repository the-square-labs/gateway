import { screen } from "@testing-library/react";
import { nodeScreenHandlers, nodeScreenSetup } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-detail-daemon-logs", async () => {
  await exportScreen({
    id: "nodes-detail-daemon-logs",
    title: "Node · Logs",
    group: "Nodes",
    route: "/nodes/edge-fra-1/daemon-logs",
    handlers: nodeScreenHandlers(),
    before: nodeScreenSetup,
    height: 1100,
    ready: async () => {
      await screen.findByText(/upstream unreachable/);
    },
    notes: ["Daemon log of edge-fra-1 from its server-sent stream (history replayed on connect)."],
  });
});
