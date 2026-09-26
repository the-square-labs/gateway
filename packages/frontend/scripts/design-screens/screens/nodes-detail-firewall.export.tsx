import { screen } from "@testing-library/react";
import { nodeScreenHandlers, nodeScreenSetup } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-detail-firewall", async () => {
  await exportScreen({
    id: "nodes-detail-firewall",
    title: "Node · Firewall",
    group: "Nodes",
    route: "/nodes/apps-2/firewall",
    handlers: nodeScreenHandlers(),
    before: nodeScreenSetup,
    height: 1100,
    ready: async () => {
      await screen.findByText("SSH from the management network");
    },
    notes: [
      "apps-2 is a Proxmox VE guest of the Lab cluster integration; its VM firewall denies inbound by default.",
    ],
  });
});
