import { screen, within } from "@testing-library/react";
import { settleDialog } from "../fixtures/ingress/interactions";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { routeHandlers } from "../fixtures/routes/handlers";
import { measureHealthBars } from "../fixtures/routes/layout";
import { exportScreen } from "../harness";

it("ingress-route-settings-dialog-add-route", async () => {
  await exportScreen({
    id: "ingress-route-settings-dialog-add-route",
    title: "Route · Add Additional Route",
    group: "Ingress",
    route: "/proxy-hosts/app/settings",
    handlers: [...routeHandlers(), ...backgroundPrewarmHandlers()],
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findAllByText("/realtime/");
      await screen.findByText("{{additionalSecureLinks.metrics}}");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: /Add route/ }));
      const dialog = await settleDialog("Add Additional Route");
      await user.type(within(dialog).getByPlaceholderText("/api"), "/uploads/");
      await user.type(within(dialog).getByPlaceholderText("192.168.1.100"), "192.0.2.60");
      const port = within(dialog).getByRole("spinbutton");
      await user.clear(port);
      await user.type(port, "9000");
    },
    notes: [
      "A new path route on app.example.com: /uploads/ → http://192.0.2.60:9000 (manual address).",
    ],
  });
});
