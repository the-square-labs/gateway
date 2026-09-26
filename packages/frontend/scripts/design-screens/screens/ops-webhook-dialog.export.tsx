import { screen, within } from "@testing-library/react";
import { waitForPageText } from "../fixtures/data/ready";
import { notificationsHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-webhook-dialog", async () => {
  await exportScreen({
    id: "ops-webhook-dialog",
    title: "Notifications · New Webhook",
    group: "Observability",
    route: "/notifications/webhooks",
    handlers: notificationsHandlers(),
    height: 1100,
    ready: async () => {
      await waitForPageText("On-call pager");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "New Webhook" }));
      const dialog = await screen.findByRole("dialog");
      const [name, url] = within(dialog).getAllByRole("textbox");
      await user.type(name, "Incident channel (Teams)");
      await user.type(url, "https://chat.example.com/hooks/incidents");
    },
  });
});
