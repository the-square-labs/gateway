import { screen } from "@testing-library/react";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { docsPortalTagHandlers } from "../fixtures/ingress/route-states";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-settings-dialog-edit-route-pages", async () => {
  await exportScreen({
    id: "ingress-route-settings-dialog-edit-route-pages",
    title: "Route · Edit Additional Route (Pages)",
    group: "Ingress",
    route: "/proxy-hosts/app/settings",
    handlers: [...docsPortalTagHandlers(), ...routeHandlers(), ...backgroundPrewarmHandlers()],
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findAllByText("/realtime/");
      await screen.findByText("{{additionalSecureLinks.metrics}}");
    },
    interact: async (user) => {
      await user.click(screen.getAllByText("/help/")[0]);
      await settleDialog("Edit Additional Route");
    },
    notes: [
      "/help/ serves the docs-portal production tag through Pages, with its availability badge.",
    ],
  });
});
