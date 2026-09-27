import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-deployments-dialog-delete", async () => {
  await exportScreen({
    id: "ingress-pages-project-deployments-dialog-delete",
    title: "Pages project · Deployments · Delete deployment",
    group: "Ingress",
    route: "/pages/marketing-site/deployments",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("w8dq2mn5ch7tzk4r");
    },
    interact: async (user) => {
      const row = screen.getByText("w8dq2mn5ch7tzk4r").closest("tr") as HTMLElement;
      await user.click(within(row).getByRole("button", { name: "Delete Deployment" }));
      await screen.findByRole("dialog", { name: "Delete Deployment" });
      await waitForReveal();
    },
    notes: [
      "Deleting the failed merge-request Deployment; a protected Deployment names the Tag or Route that keeps it.",
    ],
  });
});
