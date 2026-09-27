import { screen } from "@testing-library/react";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeDetailHandlers } from "../fixtures/ingress/route-detail";
import { staleSecureLinkHandlers } from "../fixtures/ingress/route-states";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-link-runtime-stale", async () => {
  await exportScreen({
    id: "ingress-route-link-runtime-stale",
    title: "Route · Link Runtime (stale telemetry)",
    group: "Ingress",
    route: "/proxy-hosts/app/secure-link",
    handlers: [
      ...staleSecureLinkHandlers(),
      ...routeDetailHandlers(),
      ...routeHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    height: 1500,
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findByText("Telemetry is stale");
      await screen.findByText("route_api");
    },
    notes: [
      "Secure Link telemetry has not refreshed for two minutes: the tab keeps the last sample and warns.",
    ],
  });
});
