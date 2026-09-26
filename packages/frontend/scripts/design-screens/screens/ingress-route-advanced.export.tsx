import { screen } from "@testing-library/react";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { appAdvancedConfig, routeDetailHandlers } from "../fixtures/ingress/route-detail";
import { appRoute } from "../fixtures/routes/data";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-advanced", async () => {
  await exportScreen({
    id: "ingress-route-advanced",
    title: "Route · Advanced",
    group: "Ingress",
    route: "/proxy-hosts/app/advanced",
    handlers: [...routeDetailHandlers(), ...routeHandlers(), ...backgroundPrewarmHandlers()],
    before: () => {
      // Each export file runs in its own module scope, so this stays local to this screen.
      appRoute.advancedConfig = appAdvancedConfig;
      measureHealthBars();
    },
    ready: async () => {
      await screen.findByText("Advanced Config");
      markEditors();
    },
    placeholders: [{ selector: EDITOR_SELECTOR, label: "Nginx directives editor (CodeMirror)" }],
    notes: ["The editor holds extra server-block directives for app.example.com."],
  });
});
