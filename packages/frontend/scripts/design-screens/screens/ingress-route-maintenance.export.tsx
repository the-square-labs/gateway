import { screen } from "@testing-library/react";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeDetailHandlers } from "../fixtures/ingress/route-detail";
import { enterMaintenance, routeStateHandlers } from "../fixtures/ingress/route-states";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-maintenance", async () => {
  await exportScreen({
    id: "ingress-route-maintenance",
    title: "Route · Maintenance",
    group: "Ingress",
    route: "/proxy-hosts/app/details",
    handlers: [
      ...routeStateHandlers(),
      ...routeDetailHandlers(),
      ...routeHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    height: 1100,
    before: () => {
      enterMaintenance();
      measureHealthBars();
    },
    ready: async () => {
      await screen.findByText("Maintenance mode is active");
      await screen.findByText("Ingress node");
    },
    notes: [
      "app.example.com in maintenance: every request gets HTTP 503, health checks pause and the header offers an access code.",
    ],
  });
});
