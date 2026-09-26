import { screen } from "@testing-library/react";
import { exportScreen } from "../harness";
import { expandFolders } from "../fixtures/data/folders";
import { storageFolders } from "../fixtures/data/storage";
import { storageHandlers } from "../fixtures/data/storage-handlers";

it("storage", async () => {
  await exportScreen({
    id: "storage",
    title: "Storage",
    group: "Data",
    route: "/storage",
    handlers: storageHandlers(),
    before: () => {
      expandFolders(
        "storage",
        storageFolders.map((folder) => folder.id)
      );
    },
    ready: async () => {
      await screen.findByText("partner-exports");
    },
  });
});
