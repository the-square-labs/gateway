import { screen } from "@testing-library/react";
import { pagesHandlers } from "../fixtures/data/pages-handlers";
import { pagesExtraHandlers } from "../fixtures/ingress/pages";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-pages-project-tokens", async () => {
  await exportScreen({
    id: "ingress-pages-project-tokens",
    title: "Pages project · Deploy tokens",
    group: "Ingress",
    route: "/pages/marketing-site/tokens",
    handlers: [...pagesExtraHandlers(), ...pagesHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("GitLab CI (releases)");
    },
    notes: ["Three CI deploy tokens; the local preview token expires in 11 days."],
  });
});
