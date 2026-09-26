import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { prewarmHandlers } from "../fixtures/docker/prewarm";
import { fillField } from "../fixtures/docker/ready";
import { labCluster } from "../fixtures/nodes/hosting";
import { nodesListHandlers } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-dialog-create-vm", async () => {
  await exportScreen({
    id: "nodes-dialog-create-vm",
    title: "Create VM dialog",
    group: "Nodes",
    route: `/hosting/${labCluster.id}/resources`,
    handlers: [...nodesListHandlers(), ...prewarmHandlers()],
    height: 1000,
    ready: async () => {
      await screen.findByText("win-build-test");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: /^Create VM$/i }));
      const dialog = await screen.findByRole("dialog");
      await waitForReveal();
      await fillField(user, dialog, "Build Worker", "Apps 3");
      await fillField(user, dialog, "build-worker", "apps-3");
      await releaseAnimatedHeights(dialog);
    },
    notes: ["Step 1 of creating a new Docker node as a Proxmox VE guest of the Lab cluster."],
  });
});
