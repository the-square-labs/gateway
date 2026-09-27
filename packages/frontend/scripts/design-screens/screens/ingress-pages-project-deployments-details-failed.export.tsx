import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-deployments-details-failed", async () => {
  await exportScreen({
    id: "ingress-pages-project-deployments-details-failed",
    title: "Pages project · Deployments · Failed deployment details",
    group: "Ingress",
    route: "/pages/marketing-site/deployments",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("w8dq2mn5ch7tzk4r");
    },
    interact: async (user) => {
      await user.click(screen.getByText("w8dq2mn5ch7tzk4r"));
      const dialog = await screen.findByRole("dialog", { name: "Deployment Details" });
      await within(dialog).findByText("Failure");
      await waitForReveal();
    },
    notes: [
      "A merge-request preview the server rejected: its archive held a path outside the site root, so no preview was published.",
    ],
  });
});
