import { screen } from "@testing-library/react";
import { choosePageAction, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeDetailHandlers } from "../fixtures/ingress/route-detail";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-details-dialog-delete", async () => {
  await exportScreen({
    id: "ingress-route-details-dialog-delete",
    title: "Route · Delete Route",
    group: "Ingress",
    route: "/proxy-hosts/app/details",
    handlers: [...routeDetailHandlers(), ...routeHandlers(), ...backgroundPrewarmHandlers()],
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findByText("Ingress node");
    },
    interact: async (user) => {
      await choosePageAction(user, /delete/i);
      await settleDialog("Delete Route");
    },
    notes: [
      "Delete Route from the page actions menu (the States page shows the same confirmation as a generic state).",
    ],
  });
});
