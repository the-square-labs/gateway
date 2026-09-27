import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-dialog-delete", async () => {
  await exportScreen({
    id: "ingress-pages-project-dialog-delete",
    title: "Pages project · Delete project",
    group: "Ingress",
    route: "/pages/marketing-site/deployments",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("h2x9cv7pl4dq8wme");
    },
    interact: async (user) => {
      // Secondary header actions live in the page actions menu.
      await user.click(screen.getByRole("button", { name: "Page actions" }));
      await user.click(await screen.findByRole("menuitem", { name: "Delete project" }));
      await screen.findByText(/must have no Deployments or Pages Routes/);
      await waitForReveal();
    },
    notes: [
      "Delete Page Project confirmation; the server refuses while Deployments or Pages Routes remain.",
    ],
  });
});
