import { screen } from "@testing-library/react";
import { pagesHandlers } from "../fixtures/data/pages-handlers";
import { pagesExtraHandlers } from "../fixtures/ingress/pages";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-pages-project-source", async () => {
  await exportScreen({
    id: "ingress-pages-project-source",
    title: "Pages project · Source",
    group: "Ingress",
    route: "/pages/marketing-site/source",
    handlers: [...pagesExtraHandlers(), ...pagesHandlers(), ...backgroundPrewarmHandlers()],
    height: 1700,
    ready: async () => {
      await screen.findAllByText(/northwind\/marketing-site/);
    },
    notes: ["GitLab source with pnpm build settings, one build variable and one build secret."],
  });
});
