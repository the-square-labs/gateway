import { waitForPageText } from "../fixtures/data/ready";
import { backupsStorage } from "../fixtures/data/storage";
import { storageDetailHandlers, storageHandlers } from "../fixtures/data/storage-handlers";
import { exportScreen } from "../harness";

it("data-storage-file", async () => {
  await exportScreen({
    id: "data-storage-file",
    title: "Storage file",
    group: "Data",
    route: `/storage/file/${backupsStorage.id}?bucket=db-backups&path=%2FREADME.md&writable=1`,
    handlers: [...storageDetailHandlers(), ...storageHandlers()],
    // The file window has no page reveal gate; capture once the file is open.
    captureBeforeReveal: async () => {
      await waitForPageText("README.md");
      await new Promise((resolve) => setTimeout(resolve, 600));
    },
    placeholders: [{ selector: ".cm-editor", label: "File editor (CodeMirror)" }],
    notes: [
      "Popout window opened from the object browser: README.md of the db-backups bucket, editable.",
    ],
  });
});
