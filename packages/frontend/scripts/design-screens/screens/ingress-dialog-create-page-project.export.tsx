import { screen, within } from "@testing-library/react";
import { waitForReveal } from "@/test/reveal";
import { pagesHandlers } from "../fixtures/data/pages-handlers";
import { releaseAnimatedHeights } from "../fixtures/docker/jsdom-shims";
import { pagesListRows } from "../fixtures/ingress/pages";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { exportScreen } from "../harness";

it("ingress-dialog-create-page-project", async () => {
  await exportScreen({
    id: "ingress-dialog-create-page-project",
    title: "Create Page Project dialog",
    group: "Ingress",
    route: "/pages",
    handlers: [...pagesHandlers({ projects: pagesListRows }), ...backgroundPrewarmHandlers()],
    ready: async () => {
      await screen.findAllByText("autumn-campaign");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Create project" }));
      const dialog = await screen.findByRole("dialog", { name: "Create Page Project" });
      await user.type(within(dialog).getAllByRole("textbox")[0], "partner-portal");
      await user.click(within(dialog).getByRole("combobox", { name: /node/i }));
      await user.click(await screen.findByRole("option", { name: /Edge Frankfurt/ }));
      await waitForReveal();
      await releaseAnimatedHeights(dialog);
    },
    notes: ["Creating a new static-site project placed on the Frankfurt edge."],
  });
});
