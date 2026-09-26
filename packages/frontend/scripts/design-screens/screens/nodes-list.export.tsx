import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { nodeListHandlers } from "../fixtures/edge/nodes";

it("nodes-list", async () => {
  await exportScreen({
    id: "nodes-list",
    title: "Nodes",
    group: "Screens",
    route: "/nodes",
    handlers: nodeListHandlers(),
    ready: async () => {
      await screen.findAllByText("Edge Amsterdam");
      // The Status column shows the Docker daemon patch release for both Docker nodes.
      await screen.findAllByText("2.14.1");
    },
    notes: ["A Docker daemon patch release (2.14.1) is available for apps-1 and apps-2; monitor-1 is offline."],
  });
});
