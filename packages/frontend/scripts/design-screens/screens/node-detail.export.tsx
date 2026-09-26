import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { nodeDetailHandlers } from "../fixtures/edge/node-detail";

it("node-detail", async () => {
  await exportScreen({
    id: "node-detail",
    title: "Node detail",
    group: "Screens",
    route: "/nodes/edge-fra-1",
    handlers: nodeDetailHandlers(),
    height: 1300,
    ready: async () => {
      await screen.findByText("Assigned Routes");
      await screen.findByText("grafana.example.com");
    },
    notes: [
      "Overview tab of the Frankfurt Ingress node; the CPU/memory/traffic charts live on the Monitoring tab.",
    ],
  });
});
