import { screen } from "@testing-library/react";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { hardenedProxyTemplate, nginxTemplateHandlers } from "../fixtures/ingress/nginx-templates";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-nginx-template-edit", async () => {
  await exportScreen({
    id: "ingress-nginx-template-edit",
    title: "Config Template",
    group: "Ingress",
    route: `/nginx-templates/${hardenedProxyTemplate.id}`,
    handlers: [...nginxTemplateHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findAllByText("Hardened proxy (HSTS + CSP)");
      markEditors();
    },
    placeholders: [{ selector: EDITOR_SELECTOR, label: "Nginx template editor (CodeMirror)" }],
    notes: ["A custom proxy template with its six template variables."],
  });
});
