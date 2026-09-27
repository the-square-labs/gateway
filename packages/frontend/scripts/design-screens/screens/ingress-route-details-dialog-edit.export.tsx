import { screen } from "@testing-library/react";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeDetailHandlers } from "../fixtures/ingress/route-detail";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-details-dialog-edit", async () => {
  await exportScreen({
    id: "ingress-route-details-dialog-edit",
    title: "Route · Edit Route",
    group: "Ingress",
    route: "/proxy-hosts/app/details",
    handlers: [...routeDetailHandlers(), ...routeHandlers(), ...backgroundPrewarmHandlers()],
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findByText("Ingress node");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Edit" }));
      await settleDialog("Edit Route");
      await screen.findByDisplayValue("app.example.com");
    },
    notes: [
      "Edit mode of the route dialog: only the entrypoint (type, node, domains) plus the Raw Config Mode switch.",
    ],
  });
});
