import { screen } from "@testing-library/react";
import { nodesListHandlers } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-list", async () => {
  await exportScreen({
    id: "nodes-list",
    title: "Nodes",
    group: "Nodes",
    route: "/nodes",
    handlers: nodesListHandlers(),
    ready: async () => {
      await screen.findAllByText("Edge Amsterdam");
      // The Status column shows the Docker daemon patch release for both Docker nodes.
      await screen.findAllByText("2.14.1");
    },
    notes: [
      "A Docker daemon patch release (2.14.1) is available for apps-1 and apps-2; monitor-1 is offline.",
      "apps-1, apps-2 and storage-1 run on the Lab cluster (Proxmox VE) hosting integration.",
    ],
  });
});
