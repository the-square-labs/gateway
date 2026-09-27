import { screen } from "@testing-library/react";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-deployments-no-domain", async () => {
  await exportScreen({
    id: "ingress-pages-project-deployments-no-domain",
    title: "Pages project · Deployments · No domain",
    group: "Ingress",
    route: "/pages/design-system/deployments",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("Latest immutable preview");
      await screen.findByText("m2wd8zt5qh1pkr6v");
    },
    notes: [
      "design-system has no Route domain, so the header offers its latest immutable preview (Copy preview) instead of a domain.",
    ],
  });
});
