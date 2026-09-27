import { screen, within } from "@testing-library/react";
import { http } from "msw";
import { waitForReveal } from "@/test/reveal";
import { expandFolders } from "../fixtures/data/folders";
import { pagesHandlers } from "../fixtures/data/pages-handlers";
import { pageFolders, pagesFolderRows } from "../fixtures/ingress/pages-states";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { wrapped } from "../handlers";
import { exportScreen } from "../harness";

it("ingress-pages-dialog-create-folder", async () => {
  await exportScreen({
    id: "ingress-pages-dialog-create-folder",
    title: "Pages · Add Folder dialog",
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
      await user.click(screen.getByRole("button", { name: "Add Folder" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByPlaceholderText("Folder name"), "Partners");
      await waitForReveal();
    },
    notes: ["A new top-level folder for partner-facing sites."],
  });
});
