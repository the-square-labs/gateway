import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-dialog-deploy", async () => {
  await exportScreen({
    id: "ingress-pages-project-dialog-deploy",
    title: "Pages project · Deploy dialog",
    group: "Ingress",
    route: "/pages/marketing-site/deployments",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("h2x9cv7pl4dq8wme");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Deploy" }));
      const dialog = await screen.findByRole("dialog", { name: "Deploy Page Project" });
      await within(dialog).findByText("No build selected");
      await waitForReveal();
    },
    notes: [
      "Header Deploy: a manual upload of a static build, before an archive or folder is chosen.",
    ],
  });
});
