import { screen } from "@testing-library/react";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { nginxTemplateHandlers } from "../fixtures/ingress/nginx-templates";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-nginx-template-new", async () => {
  await exportScreen({
    id: "ingress-nginx-template-new",
    title: "Create Config Template",
    group: "Ingress",
    route: "/nginx-templates/new",
    handlers: [...nginxTemplateHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("Create Config Template");
      markEditors();
    },
    placeholders: [{ selector: EDITOR_SELECTOR, label: "Nginx template editor (CodeMirror)" }],
    notes: ["A new template starts from the default proxy template body."],
  });
});
