import { screen } from "@testing-library/react";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeDetailHandlers } from "../fixtures/ingress/route-detail";
import { enterMaintenance, routeStateHandlers } from "../fixtures/ingress/route-states";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-maintenance-dialog-access-code", async () => {
  await exportScreen({
    id: "ingress-route-maintenance-dialog-access-code",
    title: "Route · Maintenance Access Code",
    group: "Ingress",
    route: "/proxy-hosts/app/details",
    handlers: [
      ...routeStateHandlers(),
      ...routeDetailHandlers(),
      ...routeHandlers(),
      ...backgroundPrewarmHandlers(),
    ],
    before: () => {
      enterMaintenance();
      measureHealthBars();
    },
    ready: async () => {
      await screen.findByText("Maintenance mode is active");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Create Maintenance Access Code" }));
      await settleDialog("Maintenance Access Code");
      await screen.findByDisplayValue("MNT-7K2Q-94XD");
    },
    notes: ["The one-time code that lets one person through maintenance for five minutes."],
  });
});
