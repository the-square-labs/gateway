import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-deployments-details", async () => {
  await exportScreen({
    id: "ingress-pages-project-deployments-details",
    title: "Pages project · Deployments · Deployment details",
    group: "Ingress",
    route: "/pages/marketing-site/deployments",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("h2x9cv7pl4dq8wme");
    },
    interact: async (user) => {
      await user.click(screen.getByText("h2x9cv7pl4dq8wme"));
      const dialog = await screen.findByRole("dialog", { name: "Deployment Details" });
      await within(dialog).findByText("Requested Tag");
      await waitForReveal();
    },
    notes: [
      "The pinned v2-8-1 release that production points at, with its immutable preview link.",
    ],
  });
});
