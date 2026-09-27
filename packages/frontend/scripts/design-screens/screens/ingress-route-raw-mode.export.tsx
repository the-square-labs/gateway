import { screen } from "@testing-library/react";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeDetailHandlers } from "../fixtures/ingress/route-detail";
import { enterRawMode } from "../fixtures/ingress/route-states";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-raw-mode", async () => {
  await exportScreen({
    id: "ingress-route-raw-mode",
    title: "Route · Raw Config (raw mode)",
    group: "Ingress",
    route: "/proxy-hosts/status/raw",
    handlers: [...routeDetailHandlers(), ...routeHandlers(), ...backgroundPrewarmHandlers()],
    before: () => {
      enterRawMode();
      measureHealthBars();
    },
    ready: async () => {
      await screen.findByText("Raw mode is active");
      await screen.findAllByText("Raw Config");
      markEditors();
    },
    placeholders: [{ selector: EDITOR_SELECTOR, label: "Raw Nginx config editor (CodeMirror)" }],
    notes: [
      "status.example.com in raw mode: template rendering is bypassed, Settings and Advanced are disabled and the config is edited directly.",
    ],
  });
});
