import { screen } from "@testing-library/react";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { choosePageAction, settleDialog } from "../fixtures/ingress/interactions";
import { nginxTemplateHandlers } from "../fixtures/ingress/nginx-templates";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-nginx-template-new-settings", async () => {
  await exportScreen({
    id: "ingress-nginx-template-new-settings",
    title: "Create Config Template · Template Settings",
    group: "Ingress",
    route: "/nginx-templates/new",
    handlers: [...nginxTemplateHandlers(), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findByText("Create Config Template");
      markEditors();
    },
    interact: async (user) => {
      await user.type(screen.getByPlaceholderText("Template name"), "Rate-limited API");
      // The header keeps Settings in its actions menu at this width.
      await choosePageAction(user, "Template settings");
      await settleDialog("Template Settings");
    },
    placeholders: [{ selector: EDITOR_SELECTOR, label: "Nginx template editor (CodeMirror)" }],
    notes: ["A new template has no custom variables yet."],
  });
});
