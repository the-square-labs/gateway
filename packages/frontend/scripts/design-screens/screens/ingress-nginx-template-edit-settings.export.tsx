import { screen } from "@testing-library/react";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { choosePageAction, settleDialog } from "../fixtures/ingress/interactions";
import { nginxTemplateStateHandlers } from "../fixtures/ingress/nginx-template-states";
import { hardenedProxyTemplate, nginxTemplateHandlers } from "../fixtures/ingress/nginx-templates";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-nginx-template-edit-settings", async () => {
  await exportScreen({
    id: "ingress-nginx-template-edit-settings",
    title: "Config Template · Template Settings",
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
      // The header keeps Settings in its actions menu at this width.
      await choosePageAction(user, "Template settings");
      await settleDialog("Template Settings");
      markEditors();
    },
    placeholders: [{ selector: EDITOR_SELECTOR, label: "Nginx template editor (CodeMirror)" }],
    notes: ["The six custom variables routes fill when they use the hardened proxy template."],
  });
});
