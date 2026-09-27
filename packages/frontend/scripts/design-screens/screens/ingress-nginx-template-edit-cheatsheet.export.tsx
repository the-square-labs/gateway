import { screen } from "@testing-library/react";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { settleDialog } from "../fixtures/ingress/interactions";
import { nginxTemplateStateHandlers } from "../fixtures/ingress/nginx-template-states";
import { hardenedProxyTemplate, nginxTemplateHandlers } from "../fixtures/ingress/nginx-templates";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-nginx-template-edit-cheatsheet", async () => {
  await exportScreen({
    id: "ingress-nginx-template-edit-cheatsheet",
    title: "Config Template · Variables Cheatsheet",
    group: "Ingress",
    route: `/nginx-templates/${hardenedProxyTemplate.id}`,
    height: 1600,
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
      await user.click(screen.getByRole("button", { name: "Variables Cheatsheet" }));
      await settleDialog("Template Cheatsheet");
      markEditors();
    },
    placeholders: [{ selector: EDITOR_SELECTOR, label: "Nginx template editor (CodeMirror)" }],
    notes: ["The variables and Handlebars helpers available in templates."],
  });
});
