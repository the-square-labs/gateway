import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers, siteArchive } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-dialog-deploy-selected", async () => {
  await exportScreen({
    id: "ingress-pages-project-dialog-deploy-selected",
    title: "Pages project · Deploy dialog · Build selected",
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
      await user.upload(archiveInput!, siteArchive());
      await within(dialog).findByText(/files ·/, {}, { timeout: 20_000 });
      await user.click(within(dialog).getByRole("combobox", { name: "Tag" }));
      await user.click(await screen.findByRole("button", { name: "production" }));
      await waitForReveal();
    },
    notes: [
      "A hotfix build archive inspected in the browser (index.html at its root) and the production Tag chosen; Upload is ready.",
    ],
  });
});
