import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-source-dialog-disconnect", async () => {
  await exportScreen({
    id: "ingress-pages-project-source-dialog-disconnect",
    title: "Pages project · Source · Disconnect repository",
    group: "Ingress",
    route: "/pages/marketing-site/source",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("SENTRY_AUTH_TOKEN");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Disconnect repository" }));
      await screen.findByRole("dialog", { name: "Disconnect Repository" });
      await waitForReveal();
    },
    notes: [
      "Disconnecting stops polling, webhooks and builds; Deployments and build history stay.",
    ],
  });
});
