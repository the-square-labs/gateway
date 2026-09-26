import { screen } from "@testing-library/react";
import { EDITOR_SELECTOR, markEditors } from "../fixtures/ingress/editor";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeDetailHandlers } from "../fixtures/ingress/route-detail";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-raw", async () => {
  await exportScreen({
    id: "ingress-route-raw",
    title: "Route · Raw Config",
    group: "Ingress",
    route: "/proxy-hosts/app/raw",
    handlers: [...routeDetailHandlers(), ...routeHandlers(), ...backgroundPrewarmHandlers()],
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findByText("Rendered Config");
      markEditors();
    },
    placeholders: [
      { selector: EDITOR_SELECTOR, label: "Rendered Nginx config (CodeMirror, read-only)" },
    ],
    notes: ["Template mode: the tab shows the rendered config; raw mode would make it editable."],
  });
});
