import { screen } from "@testing-library/react";
import { pagesHandlers } from "../fixtures/data/pages-handlers";
import { pagesListRows } from "../fixtures/ingress/pages";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-pages", async () => {
  await exportScreen({
    id: "ingress-pages",
    title: "Pages",
    group: "Ingress",
    route: "/pages",
    handlers: [...pagesHandlers({ projects: pagesListRows }), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findAllByText("autumn-campaign");
    },
    notes: ["Five static-site projects; help-center is close to its 2 GB storage quota."],
  });
});
