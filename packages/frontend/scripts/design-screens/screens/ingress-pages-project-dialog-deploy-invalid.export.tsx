import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers, wrappedSiteArchive } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-dialog-deploy-invalid", async () => {
  await exportScreen({
    id: "ingress-pages-project-dialog-deploy-invalid",
    title: "Pages project · Deploy dialog · Invalid build",
    group: "Ingress",
    route: "/pages/marketing-site/deployments",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("h2x9cv7pl4dq8wme");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Deploy" }));
      const dialog = await screen.findByRole("dialog", { name: "Deploy Page Project" });
      const archiveInput = dialog.querySelector<HTMLInputElement>(
        'input[type="file"]:not([multiple])'
      );
      await user.upload(archiveInput!, wrappedSiteArchive());
      await within(dialog).findByText(
        /index.html or index.htm at its root/,
        {},
        { timeout: 20_000 }
      );
      await waitForReveal();
    },
    notes: [
      "An archive packed with its dist/ folder is rejected in the browser before any upload: index.html must sit at the root.",
    ],
  });
});
