import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { exportScreen } from "../harness";
import { measureHealthBars } from "../fixtures/routes/layout";
import { routeHandlers } from "../fixtures/routes/handlers";

it("state-destructive-confirm", async () => {
  await exportScreen({
    id: "state-destructive-confirm",
    title: "Destructive confirmation",
    group: "States",
    route: "/proxy-hosts/app",
    handlers: routeHandlers(),
    before: () => measureHealthBars(),
    ready: async () => {
      await screen.findByText("Route Information");
      await screen.findByText("Ingress node");
    },
    interact: async (user) => {
      // Destructive header actions always live in the page actions menu.
      await user.click(screen.getByRole("button", { name: "Page actions" }));
      await user.click(await screen.findByRole("menuitem", { name: /delete/i }));
      await screen.findByRole("dialog", { name: "Delete Route" });
      await waitForReveal();
    },
    notes: [
      "Delete Route confirmation (ConfirmDialog, destructive variant) over app.example.com's Details tab.",
    ],
  });
});
