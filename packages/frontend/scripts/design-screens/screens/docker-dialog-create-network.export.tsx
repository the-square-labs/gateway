import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { dockerListHandlers } from "../fixtures/docker/handlers";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { prewarmHandlers } from "../fixtures/docker/prewarm";
import { fillField, pickOption } from "../fixtures/docker/ready";
import { exportScreen } from "../harness";

it("docker-dialog-create-network", async () => {
  await exportScreen({
    id: "docker-dialog-create-network",
    title: "Create Network dialog",
    group: "Docker",
    route: "/docker/networks",
    handlers: [...dockerListHandlers(), ...prewarmHandlers()],
    ready: async () => {
      await screen.findAllByText("northwind-db");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: /^Create Network$/i }));
      const dialog = await screen.findByRole("dialog");
      await waitForReveal();
      await pickOption(user, dialog, "Select a node", /Apps 2/);
      await fillField(user, dialog, "my-network", "northwind-edge");
      await fillField(user, dialog, "172.20.0.0/16", "172.24.0.0/16");
      await fillField(user, dialog, "172.20.0.1", "172.24.0.1");
      await releaseAnimatedHeights(dialog);
    },
    notes: ["A bridge network with a fixed subnet on apps-2."],
  });
});
