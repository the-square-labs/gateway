import { screen } from "@testing-library/react";
import { pagesHandlers } from "../fixtures/data/pages-handlers";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { pagesExtraHandlers } from "../fixtures/ingress/pages";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-pages-project-configuration", async () => {
  await exportScreen({
    id: "ingress-pages-project-configuration",
    title: "Pages project · Configuration",
    group: "Ingress",
    route: "/pages/marketing-site/configuration",
    handlers: [...pagesExtraHandlers(), ...pagesHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("Runtime configuration");
      markEditors();
    },
    placeholders: [{ selector: EDITOR_SELECTOR, label: "Runtime config JSON editor (CodeMirror)" }],
    notes: ["Default public runtime config; the production Tag carries its own override."],
  });
});
