import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-source-dialog-delete-secret", async () => {
  await exportScreen({
    id: "ingress-pages-project-source-dialog-delete-secret",
    title: "Pages project · Source · Delete Build Secret",
    group: "Ingress",
    route: "/pages/marketing-site/source",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("SENTRY_AUTH_TOKEN");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Delete SENTRY_AUTH_TOKEN" }));
      await screen.findByRole("dialog", { name: "Delete Build Secret" });
      await waitForReveal();
    },
    notes: ["Removing the SENTRY_AUTH_TOKEN Build Secret."],
  });
});
