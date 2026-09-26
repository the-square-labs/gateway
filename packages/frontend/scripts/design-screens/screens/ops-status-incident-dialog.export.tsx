import { screen, within } from "@testing-library/react";
import { waitForPageText } from "../fixtures/data/ready";
import { statusPageHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-status-incident-dialog", async () => {
  await exportScreen({
    id: "ops-status-incident-dialog",
    title: "Status Page · Create Incident",
    group: "Observability",
    route: "/status-page/incidents",
    handlers: statusPageHandlers(),
    height: 1000,
    ready: async () => {
      await waitForPageText("Payment API errors");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Create Incident" }));
      const dialog = await screen.findByRole("dialog");
      const [title] = within(dialog).getAllByRole("textbox");
      await user.type(title, "Delayed order confirmation emails");
    },
  });
});
