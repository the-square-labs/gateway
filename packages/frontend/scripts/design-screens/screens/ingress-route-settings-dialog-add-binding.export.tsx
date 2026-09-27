import { screen, within } from "@testing-library/react";
import { dialogComboboxInputs, settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-settings-dialog-add-binding", async () => {
  await exportScreen({
    id: "ingress-route-settings-dialog-add-binding",
    title: "Route · Add Binding",
    group: "Ingress",
    route: "/proxy-hosts/app/settings",
    handlers: [...routeHandlers(), ...backgroundPrewarmHandlers()],
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findAllByText("/realtime/");
      await screen.findByText("{{additionalSecureLinks.metrics}}");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: /Add binding/ }));
      const dialog = await settleDialog("Add Binding");
      await user.type(within(dialog).getByPlaceholderText("api"), "cache");
      await user.click(dialogComboboxInputs(dialog)[0]);
      await user.click(await screen.findByRole("button", { name: /^redis-cache/ }));
      await screen.findByDisplayValue("6379");
    },
    notes: [
      "A user-managed Secure Link to redis-cache on Apps 2, referenced from Advanced config as {{additionalSecureLinks.cache}}.",
    ],
  });
});
