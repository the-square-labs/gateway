import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { prewarmHandlers } from "../fixtures/docker/prewarm";
import { fillField } from "../fixtures/docker/ready";
import { nodesListHandlers } from "../fixtures/nodes/sets";
import { exportScreen } from "../harness";

it("nodes-dialog-enroll", async () => {
  await exportScreen({
    id: "nodes-dialog-enroll",
    title: "Enroll external node dialog",
    group: "Nodes",
    route: "/nodes",
    handlers: [...nodesListHandlers(), ...prewarmHandlers()],
    ready: async () => {
      await screen.findAllByText("Edge Amsterdam");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: /^Add Node$/i }));
      await screen.findByRole("dialog");
      await user.click(await screen.findByText("External VM"));
      const dialog = await screen.findByRole("dialog");
      await waitForReveal();
      await fillField(user, dialog, "US-East Ingress", "Edge London");
      await releaseAnimatedHeights(dialog);
    },
    notes: [
      "External VM chosen in Add Node: the form that creates a pending Ingress node and its setup command.",
    ],
  });
});
