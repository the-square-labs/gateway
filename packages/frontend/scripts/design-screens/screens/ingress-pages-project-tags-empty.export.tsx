import { screen } from "@testing-library/react";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-tags-empty", async () => {
  await exportScreen({
    id: "ingress-pages-project-tags-empty",
    title: "Pages project · Tags · New project",
    group: "Ingress",
    route: "/pages/partner-portal/tags",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText(/No user Tags yet/);
    },
    notes: [
      "No Tags before the first Deployment; Create or move Tag stays disabled until a Deployment is ready.",
    ],
  });
});
