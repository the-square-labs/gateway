import { screen, within } from "@testing-library/react";
import { waitForPageText } from "../fixtures/data/ready";
import { loggingHandlers } from "../fixtures/ops/handlers";
import { exportScreen } from "../harness";

it("ops-logging-environment-dialog", async () => {
  await exportScreen({
    id: "ops-logging-environment-dialog",
    title: "Logging · Create Environment",
    group: "Observability",
    route: "/logging/environments",
    handlers: loggingHandlers(),
    height: 1000,
    ready: async () => {
      await waitForPageText("Payments sandbox");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Create Environment" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getAllByRole("textbox")[0], "Mobile apps");
    },
  });
});
