import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-tags-dialog-create", async () => {
  await exportScreen({
    id: "ingress-pages-project-tags-dialog-create",
    title: "Pages project · Tags · Create or move Tag",
    group: "Ingress",
    route: "/pages/marketing-site/tags",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("v2-8-1");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Create or move Tag" }));
      const dialog = await screen.findByRole("dialog", { name: "Create or Move Tag" });
      await user.type(within(dialog).getByRole("textbox"), "staging");
      await user.click(within(dialog).getByRole("combobox"));
      await user.click(await screen.findByRole("option", { name: /n6fj3tq8zr1kxv5b/ }));
      await waitForReveal();
    },
    notes: [
      "Publishing a new staging Tag on the merge-request 121 preview; the same dialog moves an existing Tag.",
    ],
  });
});
