import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { exportScreen } from "../harness";
import { dockerListHandlers } from "../fixtures/docker/handlers";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { expandContainerFolders } from "../fixtures/docker/stores";

it("state-deploy-dialog", async () => {
  await exportScreen({
    id: "state-deploy-dialog",
    title: "Deploy dialog",
    group: "States",
    route: "/docker/containers",
    handlers: dockerListHandlers(),
    before: expandContainerFolders,
    ready: async () => {
      await screen.findByText("postgres-sidecar");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: /^deploy$/i }));
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByText("Create a container or a blue/green deployment.");
      await waitForReveal();
      await releaseAnimatedHeights(dialog);
    },
    notes: [
      "The dialog's AnimatedHeight wrapper measures 0 in jsdom; its pinned height is released so the form is not clipped.",
    ],
  });
});
