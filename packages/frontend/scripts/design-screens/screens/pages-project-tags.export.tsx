import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { pagesHandlers } from "../fixtures/data/pages-handlers";

it("pages-project-tags", async () => {
  await exportScreen({
    id: "pages-project-tags",
    title: "Pages project · Tags",
    group: "Ingress",
    route: "/pages/marketing-site/tags",
    handlers: pagesHandlers(),
    ready: async () => {
      await screen.findByText("v2.8.1");
    },
    notes: ["Tags tab: each release tag keeps a stable preview link."],
  });
});
