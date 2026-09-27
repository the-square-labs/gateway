import { screen } from "@testing-library/react";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { nginxTemplateHandlers } from "../fixtures/ingress/nginx-templates";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { nginxTemplates } from "../fixtures/routes/data";
import { exportScreen } from "../harness";

const defaultProxy = nginxTemplates.find((template) => template.name === "Default Proxy")!;

it("ingress-nginx-template-edit-builtin", async () => {
  await exportScreen({
    id: "ingress-nginx-template-edit-builtin",
    title: "Config Template · Built-in (read-only)",
    group: "Ingress",
    route: `/nginx-templates/${defaultProxy.id}`,
    handlers: [...nginxTemplateHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("Built-in template (read-only)");
      markEditors();
    },
    placeholders: [
      { selector: EDITOR_SELECTOR, label: "Nginx template editor (CodeMirror, read-only)" },
    ],
    notes: [
      "A built-in template opened directly: name, description and body are locked; Settings and Save are gone.",
    ],
  });
});
