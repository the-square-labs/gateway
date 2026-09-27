import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-source-dialog-secret-replace", async () => {
  await exportScreen({
    id: "ingress-pages-project-source-dialog-secret-replace",
    title: "Pages project · Source · Replace Build Secret",
    group: "Ingress",
    route: "/pages/marketing-site/source",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("SENTRY_AUTH_TOKEN");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Replace SENTRY_AUTH_TOKEN" }));
      const dialog = await screen.findByRole("dialog", { name: "Replace Build Secret" });
      await user.type(within(dialog).getByLabelText("Value"), "sentry-example-placeholder");
      await waitForReveal();
    },
    notes: [
      "Replacing the value of SENTRY_AUTH_TOKEN; its ID is fixed and the old value cannot be revealed.",
    ],
  });
});
