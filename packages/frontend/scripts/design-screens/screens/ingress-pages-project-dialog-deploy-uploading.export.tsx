import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import {
  manualDeployHandlers,
  pagesProjectHandlers,
  siteArchive,
} from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-dialog-deploy-uploading", async () => {
  await exportScreen({
    id: "ingress-pages-project-dialog-deploy-uploading",
    title: "Pages project · Deploy dialog · Uploading",
    group: "Ingress",
    route: "/pages/marketing-site/deployments",
    handlers: pagesProjectHandlers(...manualDeployHandlers()),
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
      await user.click(within(dialog).getByRole("button", { name: /Upload/ }));
      await within(dialog).findByText(
        /^Uploading marketing-site-hotfix\.tar\.gz/,
        {},
        { timeout: 20_000 }
      );
      await within(dialog).findByText(/^[1-9]\d%$/, {}, { timeout: 20_000 });
      await waitForReveal();
    },
    notes: [
      "The resumable upload part-way: the first 8 MiB chunk is stored and the second is in flight, so the dialog cannot be closed.",
      "The Build field and the progress row keep naming the archive and its size while it uploads.",
      "The second chunk request never answers on purpose; it shows as pending in the manifest.",
    ],
  });
});
