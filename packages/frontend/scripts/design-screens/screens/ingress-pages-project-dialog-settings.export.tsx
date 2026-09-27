import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { accessListHandlers } from "../fixtures/ingress/access-lists";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-dialog-settings", async () => {
  await exportScreen({
    id: "ingress-pages-project-dialog-settings",
    title: "Pages project · Settings dialog",
    group: "Ingress",
    route: "/pages/marketing-site/deployments",
    handlers: pagesProjectHandlers(...accessListHandlers()),
    height: 1400,
    ready: async () => {
      await screen.findByText("h2x9cv7pl4dq8wme");
    },
    interact: async (user) => {
      const header = screen
        .getByRole("heading", { level: 1, name: "marketing-site" })
        .closest("div.flex.shrink-0") as HTMLElement;
      await user.click(within(header).getByRole("button", { name: "Settings" }));
      const dialog = await screen.findByRole("dialog", { name: "Project Settings" });
      await within(dialog).findByText("Preview links");
      await waitForReveal();
    },
    notes: [
      "Project details, color, public previews, SPA fallback, retention and quota; Preview links holds the access list and link rotation.",
    ],
  });
});
