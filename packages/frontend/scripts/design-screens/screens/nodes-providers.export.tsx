import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { nodesListHandlers } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-providers", async () => {
  await exportScreen({
    id: "nodes-providers",
    title: "Nodes · Providers",
    group: "Nodes",
    route: "/nodes",
    handlers: nodesListHandlers(),
    ready: async () => {
      await screen.findAllByText("Edge Amsterdam");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("tab", { name: "Providers" }));
      await screen.findByRole("link", { name: "Open Burst capacity" });
      await waitForReveal();
    },
    notes: [
      "The Providers tab of the Nodes page: hosting integrations that create and adopt nodes.",
      "The Burst capacity account's API token was revoked, so its last sync failed.",
    ],
  });
});
