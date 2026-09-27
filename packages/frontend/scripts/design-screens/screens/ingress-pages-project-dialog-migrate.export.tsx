import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-dialog-migrate", async () => {
  await exportScreen({
    id: "ingress-pages-project-dialog-migrate",
    title: "Pages project · Migrate dialog",
    group: "Ingress",
    route: "/pages/marketing-site/deployments",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("h2x9cv7pl4dq8wme");
    },
    interact: async (user) => {
      // Secondary header actions live in the page actions menu.
      await user.click(screen.getByRole("button", { name: "Page actions" }));
      await user.click(await screen.findByRole("menuitem", { name: "Migrate" }));
      const dialog = await screen.findByRole("dialog", { name: "Migrate Page Project" });
      await user.click(within(dialog).getByRole("combobox"));
      await user.click(await screen.findByRole("option", { name: "Edge Amsterdam" }));
      await waitForReveal();
    },
    notes: [
      "Moving marketing-site from Edge Frankfurt to Edge Amsterdam, the other Pages-capable node.",
    ],
  });
});
