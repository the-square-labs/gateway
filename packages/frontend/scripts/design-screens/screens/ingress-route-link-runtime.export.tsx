import { screen } from "@testing-library/react";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeDetailHandlers } from "../fixtures/ingress/route-detail";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-link-runtime", async () => {
  await exportScreen({
    id: "ingress-route-link-runtime",
    title: "Route · Link Runtime",
    group: "Ingress",
    route: "/proxy-hosts/app/secure-link",
    handlers: [...routeDetailHandlers(), ...routeHandlers(), ...backgroundPrewarmHandlers()],
    height: 1500,
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findAllByText("Active streams");
      await screen.findByText("route_api");
    },
    notes: [
      "Secure Link telemetry over the last two minutes (60 polls); sparklines are real SVG.",
      "The metrics binding is still provisioning, so it shows no runtime yet.",
    ],
  });
});
