import { screen } from "@testing-library/react";
import { pagesHandlers } from "../fixtures/data/pages-handlers";
import { pagesExtraHandlers } from "../fixtures/ingress/pages";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-pages-project-builds", async () => {
  await exportScreen({
    id: "ingress-pages-project-builds",
    title: "Pages project · Builds",
    group: "Ingress",
    route: "/pages/marketing-site/builds",
    handlers: [...pagesExtraHandlers(), ...pagesHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findAllByText(/9f3c2a1/);
    },
    notes: ["The six latest builds of marketing-site; one failed on a missing i18n file."],
  });
});
