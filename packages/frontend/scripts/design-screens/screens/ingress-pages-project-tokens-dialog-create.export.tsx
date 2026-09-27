import { fireEvent, screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { deployTokenHandlers, pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-tokens-dialog-create", async () => {
  await exportScreen({
    id: "ingress-pages-project-tokens-dialog-create",
    title: "Pages project · Deploy tokens · Create token",
    group: "Ingress",
    route: "/pages/marketing-site/tokens",
    handlers: pagesProjectHandlers(...deployTokenHandlers()),
    ready: async () => {
      await screen.findByText("GitLab CI (releases)");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Create token" }));
      const dialog = await screen.findByRole("dialog", { name: "Create Deploy Token" });
      await user.type(
        within(dialog).getByPlaceholderText("GitLab Pages webhook"),
        "GitLab CI (staging)"
      );
      await user.type(
        within(dialog).getByRole("textbox", { name: "Allowed Tag patterns" }),
        "staging"
      );
      fireEvent.change(within(dialog).getByLabelText("Deploy token expiration"), {
        target: { value: "2027-03-31T09:00" },
      });
      await waitForReveal();
    },
    notes: ["A CI token limited to publishing the staging Tag, expiring at the end of March."],
  });
});
