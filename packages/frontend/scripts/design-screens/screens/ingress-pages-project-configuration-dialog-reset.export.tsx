import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-configuration-dialog-reset", async () => {
  await exportScreen({
    id: "ingress-pages-project-configuration-dialog-reset",
    title: "Pages project · Configuration · Reset Tag configuration",
    group: "Ingress",
    route: "/pages/marketing-site/configuration",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("Runtime configuration");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("combobox", { name: "Runtime configuration target" }));
      await user.click(await screen.findByRole("option", { name: "production" }));
      markEditors();
      await user.click(await screen.findByRole("button", { name: "Reset to default" }));
      await screen.findByRole("dialog", { name: "Reset Tag Configuration?" });
      await waitForReveal();
    },
    placeholders: [{ selector: EDITOR_SELECTOR, label: "Runtime config JSON editor (CodeMirror)" }],
    notes: ["Resetting the production override republishes the Default configuration to that Tag."],
  });
});
