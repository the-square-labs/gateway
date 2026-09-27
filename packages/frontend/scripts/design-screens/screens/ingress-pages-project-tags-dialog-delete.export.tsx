import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-tags-dialog-delete", async () => {
  await exportScreen({
    id: "ingress-pages-project-tags-dialog-delete",
    title: "Pages project · Tags · Delete Tag",
    group: "Ingress",
    route: "/pages/marketing-site/tags",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("v2-8-0");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Delete v2-8-0 Tag" }));
      await screen.findByRole("dialog", { name: "Delete Tag" });
      await waitForReveal();
    },
    notes: [
      "Deleting the superseded v2-8-0 Tag; Routes that reference a Tag must be retargeted first.",
    ],
  });
});
