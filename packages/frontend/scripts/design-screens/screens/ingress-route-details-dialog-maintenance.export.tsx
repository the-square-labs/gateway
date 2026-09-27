import { screen } from "@testing-library/react";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeDetailHandlers } from "../fixtures/ingress/route-detail";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-details-dialog-maintenance", async () => {
  await exportScreen({
    id: "ingress-route-details-dialog-maintenance",
    title: "Route · Enable Maintenance",
    group: "Ingress",
    route: "/proxy-hosts/app/details",
    handlers: [...routeDetailHandlers(), ...routeHandlers(), ...backgroundPrewarmHandlers()],
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findByText("Ingress node");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Enable Maintenance" }));
      await settleDialog("Enable Maintenance Mode");
    },
    notes: ["Confirmation before app.example.com answers every request with HTTP 503."],
  });
});
