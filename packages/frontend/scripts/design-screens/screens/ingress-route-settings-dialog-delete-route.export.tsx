import { screen } from "@testing-library/react";
import { chooseRowAction, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-settings-dialog-delete-route", async () => {
  await exportScreen({
    id: "ingress-route-settings-dialog-delete-route",
    title: "Route · Delete Additional Route",
    group: "Ingress",
    route: "/proxy-hosts/app/settings",
    handlers: [...routeHandlers(), ...backgroundPrewarmHandlers()],
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findAllByText("/realtime/");
      await screen.findByText("{{additionalSecureLinks.metrics}}");
    },
    interact: async (user) => {
      await chooseRowAction(user, "/legacy/", "Actions for /legacy/", "Delete");
      await settleDialog("Delete Additional Route?");
    },
    notes: ["Removing the disabled /legacy/ path route."],
  });
});
