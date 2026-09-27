import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-dialog-deploy-instructions", async () => {
  await exportScreen({
    id: "ingress-pages-project-dialog-deploy-instructions",
    title: "Pages project · Deploy instructions",
    group: "Ingress",
    route: "/pages/marketing-site/deployments",
    handlers: pagesProjectHandlers(),
    height: 1100,
    ready: async () => {
      await screen.findByText("h2x9cv7pl4dq8wme");
    },
    interact: async (user) => {
      // Secondary header actions live in the page actions menu.
      await user.click(screen.getByRole("button", { name: "Page actions" }));
      await user.click(await screen.findByRole("menuitem", { name: "Deploy instructions" }));
      const dialog = await screen.findByRole("dialog", { name: "Deploy Instructions" });
      await within(dialog).findByText("Upload and Finalize");
      await waitForReveal();
    },
    notes: [
      "The resumable webhook API for CI: create an upload with a deploy token, send the archive, finalize.",
    ],
  });
});
