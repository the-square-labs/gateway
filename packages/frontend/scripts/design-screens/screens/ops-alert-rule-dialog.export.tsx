import { screen, within } from "@testing-library/react";
import { notificationsHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-alert-rule-dialog", async () => {
  await exportScreen({
    id: "ops-alert-rule-dialog",
    title: "Notifications · New Alert",
    group: "Observability",
    route: "/notifications/alerts",
    handlers: notificationsHandlers(),
    height: 1100,
    ready: async () => {
      await screen.findByText("Container restart loop");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "New Alert" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getAllByRole("textbox")[0], "Checkout latency above SLO");
    },
  });
});
