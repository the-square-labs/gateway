import { screen } from "@testing-library/react";
import { pagesHandlers } from "../fixtures/data/pages-handlers";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-pages-empty", async () => {
  await exportScreen({
    id: "ingress-pages-empty",
    title: "Pages · Empty",
    group: "Ingress",
    route: "/pages",
    handlers: [...pagesHandlers({ projects: [] }), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText(/No Page Projects yet/);
    },
    notes: ["An installation that has not created a Pages project yet."],
  });
});
