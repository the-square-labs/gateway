import { screen } from "@testing-library/react";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-tokens-empty", async () => {
  await exportScreen({
    id: "ingress-pages-project-tokens-empty",
    title: "Pages project · Deploy tokens · New project",
    group: "Ingress",
    route: "/pages/partner-portal/tokens",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("No deploy tokens have been created.");
    },
    notes: ["A new project has no deploy tokens yet."],
  });
});
