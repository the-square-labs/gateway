import { screen } from "@testing-library/react";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-settings-dialog-remove-binding", async () => {
  await exportScreen({
    id: "ingress-route-settings-dialog-remove-binding",
    title: "Route · Remove Binding",
    group: "Ingress",
    route: "/proxy-hosts/app/settings",
    handlers: [...routeHandlers(), ...backgroundPrewarmHandlers()],
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findAllByText("/realtime/");
      await screen.findByText("{{additionalSecureLinks.metrics}}");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Remove metrics" }));
      await settleDialog("Remove Additional Secure Link?");
    },
    notes: ["De-provisioning the user-managed metrics binding from both nodes."],
  });
});
