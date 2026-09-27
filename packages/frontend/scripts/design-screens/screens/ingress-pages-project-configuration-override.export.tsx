import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-configuration-override", async () => {
  await exportScreen({
    id: "ingress-pages-project-configuration-override",
    title: "Pages project · Configuration · Tag override",
    group: "Ingress",
    route: "/pages/marketing-site/configuration",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("Runtime configuration");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("combobox", { name: "Runtime configuration target" }));
      await user.click(await screen.findByRole("option", { name: "production" }));
      await screen.findByRole("button", { name: "Reset to default" });
      await waitForReveal();
      markEditors();
    },
    placeholders: [{ selector: EDITOR_SELECTOR, label: "Runtime config JSON editor (CodeMirror)" }],
    notes: [
      "The production Tag carries its own configuration (pricingV2 on); Reset to default drops the override.",
    ],
  });
});
