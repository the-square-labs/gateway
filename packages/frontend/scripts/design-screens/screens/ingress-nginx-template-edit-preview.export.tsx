import { screen } from "@testing-library/react";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { settleDialog } from "../fixtures/ingress/interactions";
import { nginxTemplateStateHandlers } from "../fixtures/ingress/nginx-template-states";
import { hardenedProxyTemplate, nginxTemplateHandlers } from "../fixtures/ingress/nginx-templates";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-nginx-template-edit-preview", async () => {
  await exportScreen({
    id: "ingress-nginx-template-edit-preview",
    title: "Config Template · Rendered Preview",
    group: "Ingress",
    route: `/nginx-templates/${hardenedProxyTemplate.id}`,
    handlers: [
      ...nginxTemplateStateHandlers(),
      ...nginxTemplateHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    ready: async () => {
      await screen.findAllByText("Hardened proxy (HSTS + CSP)");
      markEditors();
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Preview" }));
      await settleDialog("Rendered Preview");
      markEditors();
    },
    placeholders: [{ selector: EDITOR_SELECTOR, label: "Nginx config editor (CodeMirror)" }],
    notes: ["The hardened proxy template rendered with sample data."],
  });
});
