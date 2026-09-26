import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { prewarmHandlers } from "../fixtures/docker/prewarm";
import { nodesListHandlers } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-dialog-add-node", async () => {
  await exportScreen({
    id: "nodes-dialog-add-node",
    title: "Add Node dialog",
    group: "Nodes",
    route: "/nodes",
    handlers: [...nodesListHandlers(), ...prewarmHandlers()],
    ready: async () => {
      await screen.findAllByText("Edge Amsterdam");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: /^Add Node$/i }));
      const dialog = await screen.findByRole("dialog");
      await waitForReveal();
      await releaseAnimatedHeights(dialog);
    },
    notes: [
      "The Add Node entrypoint: connect an existing machine or create a VM through a hosting integration.",
    ],
  });
});
