import { screen } from "@testing-library/react";
import { http } from "msw";
import { expandFolders } from "../fixtures/data/folders";
import { pagesHandlers } from "../fixtures/data/pages-handlers";
import { pageFolders, pagesFolderRows } from "../fixtures/ingress/pages-states";
import { backgroundPrewarmHandlers } from "../fixtures/ingress/prewarm";
import { wrapped } from "../handlers";
import { exportScreen } from "../harness";

it("ingress-pages-folders", async () => {
  await exportScreen({
    id: "ingress-pages-folders",
    title: "Pages · Folders",
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
      await screen.findAllByText("autumn-campaign");
    },
    notes: ["Projects filed into Campaigns and Product folders; marketing-site stays ungrouped."],
  });
});
