import { screen } from "@testing-library/react";
import { nodeScreenHandlers, nodeScreenSetup } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-detail-jobs", async () => {
  await exportScreen({
    id: "nodes-detail-jobs",
    title: "Node · Jobs",
    group: "Nodes",
    route: "/nodes/build-1/jobs",
    handlers: nodeScreenHandlers(),
    before: nodeScreenSetup,
    height: 1100,
    ready: async () => {
      await screen.findByText("7ad1e0c9d7");
    },
    notes: [
      "build-1 is a dedicated Build worker node; it runs every Git build of the Docker area.",
    ],
  });
});
