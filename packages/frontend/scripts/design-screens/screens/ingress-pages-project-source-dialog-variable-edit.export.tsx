import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-source-dialog-variable-edit", async () => {
  await exportScreen({
    id: "ingress-pages-project-source-dialog-variable-edit",
    title: "Pages project · Source · Edit Build Variable",
    group: "Ingress",
    route: "/pages/marketing-site/source",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("SENTRY_AUTH_TOKEN");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Edit PUBLIC_SITE_URL" }));
      await screen.findByRole("dialog", { name: "Edit Build Variable" });
      await waitForReveal();
    },
    notes: ["Editing the existing PUBLIC_SITE_URL variable."],
  });
});
