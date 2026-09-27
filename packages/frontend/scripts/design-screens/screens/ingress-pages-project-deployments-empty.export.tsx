import { screen } from "@testing-library/react";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-deployments-empty", async () => {
  await exportScreen({
    id: "ingress-pages-project-deployments-empty",
    title: "Pages project · Deployments · New project",
    group: "Ingress",
    route: "/pages/partner-portal/deployments",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText(/No Deployments yet/);
    },
    notes: [
      "Where Create Page Project lands: partner-portal on Edge Frankfurt, nothing deployed, no domain or preview yet.",
    ],
  });
});
