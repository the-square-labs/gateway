import { screen } from "@testing-library/react";
import { pagesHandlers } from "../fixtures/data/pages-handlers";
import { exportScreen } from "../harness";

it("ingress-pages-project-deployments", async () => {
  await exportScreen({
    id: "ingress-pages-project-deployments",
    title: "Pages project · Deployments",
    group: "Ingress",
    route: "/pages/marketing-site/deployments",
    handlers: pagesHandlers(),
    ready: async () => {
      await screen.findByText("h2x9cv7pl4dq8wme");
    },
    notes: [
      "Release tags (v2-8-1, v2-8-0, v2-7-4) publish production; merge requests publish expiring previews.",
      "Stable Tag preview links render on the Tags tab, not here; the fixtures serve them at /pages/:id/tags.",
    ],
  });
});
