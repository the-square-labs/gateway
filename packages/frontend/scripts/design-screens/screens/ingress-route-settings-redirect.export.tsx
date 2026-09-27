import { screen } from "@testing-library/react";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeDetailHandlers } from "../fixtures/ingress/route-detail";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-settings-redirect", async () => {
  await exportScreen({
    id: "ingress-route-settings-redirect",
    title: "Route · Settings (redirect)",
    group: "Ingress",
    route: "/proxy-hosts/staging-app/settings",
    handlers: [...routeDetailHandlers(), ...routeHandlers(), ...backgroundPrewarmHandlers()],
    height: 1100,
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findByText("Redirect URL");
      await screen.findByDisplayValue("https://app.example.com");
    },
    notes: [
      "A disabled redirect route: no upstream, additional routes or bindings; the template panel holds the redirect target and status.",
    ],
  });
});
