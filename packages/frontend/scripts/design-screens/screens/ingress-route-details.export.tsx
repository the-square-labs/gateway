import { screen } from "@testing-library/react";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeDetailHandlers } from "../fixtures/ingress/route-detail";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-details", async () => {
  await exportScreen({
    id: "ingress-route-details",
    title: "Route · Details",
    group: "Ingress",
    route: "/proxy-hosts/app/details",
    handlers: [...routeDetailHandlers(), ...routeHandlers(), ...backgroundPrewarmHandlers()],
    height: 1100,
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findByText("Ingress node");
      await screen.findAllByText("/healthz");
    },
    notes: ["app.example.com → Docker container web on Apps 1 over Secure Link."],
  });
});
