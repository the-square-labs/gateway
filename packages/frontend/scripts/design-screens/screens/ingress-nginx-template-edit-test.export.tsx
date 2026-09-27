import { screen } from "@testing-library/react";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { nginxTemplateStateHandlers } from "../fixtures/ingress/nginx-template-states";
import { hardenedProxyTemplate, nginxTemplateHandlers } from "../fixtures/ingress/nginx-templates";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-nginx-template-edit-test", async () => {
  await exportScreen({
    id: "ingress-nginx-template-edit-test",
    title: "Config Template · Test passed",
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
      await user.click(screen.getByRole("button", { name: "Test" }));
      await screen.findByText("Config test passed");
    },
    placeholders: [{ selector: EDITOR_SELECTOR, label: "Nginx template editor (CodeMirror)" }],
    notes: ["Test renders the template and runs nginx -t on it; the result arrives as a toast."],
  });
});
