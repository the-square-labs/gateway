import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { measureHealthBars } from "../fixtures/routes/layout";
import { routeHandlers } from "../fixtures/routes/handlers";

it("route-detail-settings", async () => {
  await exportScreen({
    id: "route-detail-settings",
    title: "Route detail · Settings",
    group: "Ingress",
    route: "/proxy-hosts/app/settings",
    handlers: routeHandlers(),
    height: 1400,
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findAllByText("/realtime/");
      await screen.findByText("{{additionalSecureLinks.metrics}}");
    },
    notes: [
      "app.example.com → Docker container web on Apps 1 over Secure Link, with additional routes and bindings.",
      "Health bars: the container width is reported as 1136px so jsdom draws the real bar count.",
    ],
  });
});
