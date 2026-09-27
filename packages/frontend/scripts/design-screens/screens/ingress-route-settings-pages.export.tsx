import { screen } from "@testing-library/react";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeDetailHandlers } from "../fixtures/ingress/route-detail";
import { docsPortalTagHandlers } from "../fixtures/ingress/route-states";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-settings-pages", async () => {
  await exportScreen({
    id: "ingress-route-settings-pages",
    title: "Route · Settings (Pages target)",
    group: "Ingress",
    route: "/proxy-hosts/docs/settings",
    handlers: [
      ...docsPortalTagHandlers(),
      ...routeDetailHandlers(),
      ...routeHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    height: 1400,
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findByText("Config Template");
      await screen.findAllByText(/docs-portal/);
    },
    notes: ["docs.example.org serves the docs-portal production tag through Pages."],
  });
});
