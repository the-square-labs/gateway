import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-source-dialog-secret-add", async () => {
  await exportScreen({
    id: "ingress-pages-project-source-dialog-secret-add",
    title: "Pages project · Source · Add Build Secret",
    group: "Ingress",
    route: "/pages/marketing-site/source",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("SENTRY_AUTH_TOKEN");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Add secret" }));
      const dialog = await screen.findByRole("dialog", { name: "Add Build Secret" });
      await user.type(within(dialog).getByLabelText("Secret ID"), "NPM_TOKEN");
      await user.type(within(dialog).getByLabelText("Value"), "npm-example-placeholder");
      await waitForReveal();
    },
    notes: [
      "A write-only secret for private npm packages, exposed only to the isolated install and build.",
    ],
  });
});
