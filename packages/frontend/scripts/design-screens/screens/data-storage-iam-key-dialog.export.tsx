import { screen, within } from "@testing-library/react";
import { managedNodeHandlers } from "../fixtures/data/database-handlers";
import { waitForPageText } from "../fixtures/data/ready";
import { storageDetailHandlers, storageHandlers } from "../fixtures/data/storage-handlers";
import { installBackupsStreams } from "../fixtures/data/storage-streams";
import { exportScreen } from "../harness";

it("data-storage-iam-key-dialog", async () => {
  await exportScreen({
    id: "data-storage-iam-key-dialog",
    title: "Storage · Create Access Key",
    group: "Data",
    route: "/storage/backups/iam-keys",
    handlers: [...storageDetailHandlers(), ...storageHandlers(), ...managedNodeHandlers()],
    before: installBackupsStreams,
    ready: async () => {
      await waitForPageText("backup-runner");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Create key" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getAllByRole("textbox")[0], "ci-uploads");
    },
  });
});
