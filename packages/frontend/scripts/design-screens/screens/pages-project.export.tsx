import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { pagesHandlers } from "../fixtures/data/pages-handlers";

it("pages-project", async () => {
  await exportScreen({
    id: "pages-project",
    title: "Pages project · Deployments",
    group: "Screens",
    route: "/pages/marketing-site/deployments",
    handlers: pagesHandlers(),
    ready: async () => {
      await screen.findByText("h2x9cv7pl4dq8wme");
    },
    notes: [
      "Release tags (v2.8.1, v2.8.0, v2.7.4) publish production; merge requests publish expiring previews.",
      "Stable Tag preview links render on the Tags tab, not here; the fixtures serve them at /pages/:id/tags.",
    ],
  });
});
