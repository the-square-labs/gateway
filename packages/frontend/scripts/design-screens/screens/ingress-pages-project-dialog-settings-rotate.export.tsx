import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { accessListHandlers } from "../fixtures/ingress/access-lists";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-dialog-settings-rotate", async () => {
  await exportScreen({
    id: "ingress-pages-project-dialog-settings-rotate",
    title: "Pages project · Settings dialog · Rotate preview links",
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
      await user.click(within(dialog).getByRole("button", { name: "Rotate preview links" }));
      await screen.findByRole("dialog", { name: "Rotate Preview Links" });
      await waitForReveal();
    },
    notes: [
      "Rotating replaces every Deployment and Tag preview link at once; custom-domain Routes keep working.",
    ],
  });
});
