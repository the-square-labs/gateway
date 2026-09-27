import { screen } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-tokens-dialog-revoke", async () => {
  await exportScreen({
    id: "ingress-pages-project-tokens-dialog-revoke",
    title: "Pages project · Deploy tokens · Revoke token",
    group: "Ingress",
    route: "/pages/marketing-site/tokens",
    handlers: pagesProjectHandlers(),
    ready: async () => {
      await screen.findByText("Local preview (Omar)");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Revoke Local preview (Omar)" }));
      await screen.findByRole("dialog", { name: "Revoke Deploy Token" });
      await waitForReveal();
    },
    notes: [
      "Revoking the soon-to-expire local preview token; uploads using its prefix stop authenticating.",
    ],
  });
});
