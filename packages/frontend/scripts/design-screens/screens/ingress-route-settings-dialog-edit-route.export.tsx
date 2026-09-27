import { screen } from "@testing-library/react";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-settings-dialog-edit-route", async () => {
  await exportScreen({
    id: "ingress-route-settings-dialog-edit-route",
    title: "Route · Edit Additional Route",
    group: "Ingress",
    route: "/proxy-hosts/app/settings",
    handlers: [...routeHandlers(), ...backgroundPrewarmHandlers()],
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findAllByText("/realtime/");
      await screen.findByText("{{additionalSecureLinks.metrics}}");
    },
    interact: async (user) => {
      await user.click(screen.getAllByText("/realtime/")[0]);
      await settleDialog("Edit Additional Route");
      await screen.findByDisplayValue("8081");
    },
    notes: [
      "Editing /realtime/ (worker container on Apps 1): path and target are fixed once created.",
    ],
  });
});
