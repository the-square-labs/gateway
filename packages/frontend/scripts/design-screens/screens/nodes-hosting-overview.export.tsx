import { screen } from "@testing-library/react";
import { labCluster } from "../fixtures/nodes/hosting";
import { nodesListHandlers } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-hosting-overview", async () => {
  await exportScreen({
    id: "nodes-hosting-overview",
    title: "Hosting integration · Overview",
    group: "Nodes",
    route: `/hosting/${labCluster.id}/overview`,
    handlers: nodesListHandlers(),
    height: 1100,
    ready: async () => {
      await screen.findByText("Proxmox capacity");
    },
    notes: ["A self-hosted Proxmox VE cluster (two hosts) that runs apps-1, apps-2 and storage-1."],
  });
});
