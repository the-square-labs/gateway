import { screen } from "@testing-library/react";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-source-connect", async () => {
  await exportScreen({
    id: "ingress-pages-project-source-connect",
    title: "Pages project · Source · No repository",
    group: "Ingress",
    route: "/pages/partner-portal/source",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText(/No repository connected/);
    },
    notes: [
      "partner-portal has no repository yet; it keeps accepting manual Deployments until one is connected.",
    ],
  });
});
