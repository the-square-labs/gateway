import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { connectRepositoryHandlers, pagesProjectHandlers } from "../fixtures/ingress/pages-states";
import { exportScreen } from "../harness";

it("ingress-pages-project-source-connect-step-1", async () => {
  await exportScreen({
    id: "ingress-pages-project-source-connect-step-1",
    title: "Pages project · Source · Connect repository (1 of 2)",
    group: "Ingress",
    route: "/pages/partner-portal/source",
    handlers: pagesProjectHandlers(...connectRepositoryHandlers()),
    ready: async () => {
      await screen.findByText(/No repository connected/);
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Connect repository" }));
      const dialog = await screen.findByRole("dialog", { name: "Connect Repository" });
      await user.click(within(dialog).getByPlaceholderText("Select Git integration"));
      await user.click(await screen.findByRole("button", { name: "Northwind GitLab" }));
      await user.click(within(dialog).getByPlaceholderText("Select allowlisted repository"));
      await user.click(await screen.findByRole("button", { name: "northwind/partner-portal" }));
      await waitForReveal();
      await releaseAnimatedHeights(dialog);
    },
    notes: [
      "Step 1 of the Pages connect wizard: Git integration, allowlisted repository, branch and application root.",
    ],
  });
});
