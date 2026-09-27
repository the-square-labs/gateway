import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-configuration-inherited", async () => {
  await exportScreen({
    id: "ingress-pages-project-configuration-inherited",
    title: "Pages project · Configuration · Inherited Tag",
    group: "Ingress",
    route: "/pages/marketing-site/configuration",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("Runtime configuration");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("combobox", { name: "Runtime configuration target" }));
      await user.click(await screen.findByRole("option", { name: "v2-8-1" }));
      await screen.findByText("Inherited");
      await waitForReveal();
      markEditors();
    },
    placeholders: [{ selector: EDITOR_SELECTOR, label: "Runtime config JSON editor (CodeMirror)" }],
    notes: [
      "The v2-8-1 Tag has no override: it shows the Default configuration, marked Inherited; saving creates an override.",
    ],
  });
});
