import { screen } from "@testing-library/react";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-builds-empty", async () => {
  await exportScreen({
    id: "ingress-pages-project-builds-empty",
    title: "Pages project · Builds · New project",
    group: "Ingress",
    route: "/pages/partner-portal/builds",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("No builds yet.");
    },
    notes: ["No repository is connected yet, so partner-portal has no builds."],
  });
});
