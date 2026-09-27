import { screen, within } from "@testing-library/react";
import { http } from "msw";
import { waitForReveal } from "@/test/reveal";
import { expandFolders } from "../fixtures/data/folders";
import { pagesHandlers } from "../fixtures/data/pages-handlers";
import { pageFolders, pagesFolderRows } from "../fixtures/ingress/pages-states";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { wrapped } from "../handlers";
import { exportScreen } from "../harness";

it("ingress-pages-dialog-delete-folder", async () => {
  await exportScreen({
    id: "ingress-pages-dialog-delete-folder",
    title: "Pages · Delete Folder",
    group: "Ingress",
    route: "/pages",
    handlers: [
      http.get("*/api/pages/folders", () => wrapped(pageFolders)),
      ...pagesHandlers({ projects: pagesFolderRows }),
      ...backgroundPrewarmHandlers(),
    ],
    before: () => {
      expandFolders(
        "pages-project",
        pageFolders.map((folder) => folder.id)
      );
    },
    ready: async () => {
      await screen.findByText("Campaigns");
    },
    interact: async (user) => {
      const row = screen.getByText("Campaigns").closest("div.flex") as HTMLElement;
      await user.click(within(row).getByRole("button", { name: "Folder actions" }));
      await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
      await screen.findByRole("dialog", { name: "Delete Folder" });
      await waitForReveal();
    },
    notes: ["Deleting the Campaigns folder moves its projects back to the ungrouped list."],
  });
});
