import { screen } from "@testing-library/react";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeDetailHandlers } from "../fixtures/ingress/route-detail";
import { failTlsDistribution } from "../fixtures/ingress/route-states";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-settings-tls-distribution", async () => {
  await exportScreen({
    id: "ingress-route-settings-tls-distribution",
    title: "Route · Settings (TLS sync failed)",
    group: "Ingress",
    route: "/proxy-hosts/api/settings",
    handlers: [...routeDetailHandlers(), ...routeHandlers(), ...backgroundPrewarmHandlers()],
    height: 1400,
    before: () => {
      failTlsDistribution();
      measureHealthBars();
    },
    ready: async () => {
      await screen.findByText("TLS distribution");
      await screen.findByText("Config Template");
    },
    notes: [
      "api.example.com after a renewal one edge replica never confirmed: the TLS distribution panel and Retry TLS Sync appear.",
    ],
  });
});
