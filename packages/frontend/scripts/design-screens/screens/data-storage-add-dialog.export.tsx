import { screen, within } from "@testing-library/react";
import { managedNodeHandlers } from "../fixtures/data/database-handlers";
import { expandFolders } from "../fixtures/data/folders";
import { storageFolders } from "../fixtures/data/storage";
import { storageHandlers } from "../fixtures/data/storage-handlers";
import { exportScreen } from "../harness";

it("data-storage-add-dialog", async () => {
  await exportScreen({
    id: "data-storage-add-dialog",
    title: "Storage · Add Storage",
    group: "Data",
    route: "/storage",
    handlers: [...managedNodeHandlers(), ...storageHandlers()],
    height: 1000,
    before: () => {
      expandFolders(
        "storage",
        storageFolders.map((folder) => folder.id)
      );
    },
    ready: async () => {
      await screen.findByText("partner-exports");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Connect existing" }));
      const dialog = await screen.findByRole("dialog");
      const [name, , , endpoint, region, accessKey] = within(dialog).getAllByRole("textbox");
      await user.type(name, "media-archive");
      await user.type(endpoint, "https://s3.eu-central-1.example.com");
      await user.clear(region);
      await user.type(region, "eu-central-1");
      await user.type(accessKey, "AKIAEXAMPLEMEDIA01");
    },
    notes: [
      "Connect an existing S3-compatible, SFTP or FTP storage, opened from the Storage list.",
    ],
  });
});
