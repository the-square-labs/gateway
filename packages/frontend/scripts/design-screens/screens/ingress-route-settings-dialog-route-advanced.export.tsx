import { screen } from "@testing-library/react";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { chooseRowAction, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { appAdditionalRoutes } from "../fixtures/routes/data";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-settings-dialog-route-advanced", async () => {
  await exportScreen({
    id: "ingress-route-settings-dialog-route-advanced",
    title: "Route · Edit Advanced Config (additional route)",
    group: "Ingress",
    route: "/proxy-hosts/app/settings",
    handlers: [...routeHandlers(), ...backgroundPrewarmHandlers()],
    before: () => {
      appAdditionalRoutes[0].advancedConfig = "client_max_body_size 50m;\nproxy_read_timeout 120s;";
      measureHealthBars();
    },
    ready: async () => {
      await screen.findAllByText("/realtime/");
      await screen.findByText("{{additionalSecureLinks.metrics}}");
    },
    interact: async (user) => {
      await chooseRowAction(user, "/api/", "Actions for /api/", "Edit advanced config");
      await settleDialog("Edit Advanced Config");
      markEditors();
    },
    placeholders: [{ selector: EDITOR_SELECTOR, label: "Location directives editor (CodeMirror)" }],
    notes: ["Extra Nginx directives inside the /api/ location of app.example.com."],
  });
});
