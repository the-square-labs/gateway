import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-source-dialog-variable-add", async () => {
  await exportScreen({
    id: "ingress-pages-project-source-dialog-variable-add",
    title: "Pages project · Source · Add Build Variable",
    group: "Ingress",
    route: "/pages/marketing-site/source",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("SENTRY_AUTH_TOKEN");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Add variable" }));
      const dialog = await screen.findByRole("dialog", { name: "Add Build Variable" });
      await user.type(within(dialog).getByLabelText("Name"), "VITE_ANALYTICS_SITE_ID");
      await user.type(within(dialog).getByLabelText("Value"), "northwind-www");
      await waitForReveal();
    },
    notes: [
      "A public VITE_* value for the client bundle; it saves with the Build Variables section.",
    ],
  });
});
