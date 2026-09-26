import { managedNodeHandlers } from "../fixtures/data/database-handlers";
import { waitForPageText } from "../fixtures/data/ready";
import { storageDetailHandlers, storageHandlers } from "../fixtures/data/storage-handlers";
import { installBackupsStreams } from "../fixtures/data/storage-streams";
import { exportScreen } from "../harness";

it("data-storage-objects", async () => {
  await exportScreen({
    id: "data-storage-objects",
    title: "Storage · Objects",
    group: "Data",
    route: "/storage/backups/browser",
    handlers: [...storageDetailHandlers(), ...storageHandlers(), ...managedNodeHandlers()],
    before: installBackupsStreams,
    ready: async () => {
      await waitForPageText("retention-policy.json", "orders-db");
    },
    notes: ["Object browser on the db-backups bucket of the managed backups storage."],
  });
});
