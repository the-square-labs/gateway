import { managedNodeHandlers } from "../fixtures/data/database-handlers";
import { waitForPageText } from "../fixtures/data/ready";
import { storageDetailHandlers, storageHandlers } from "../fixtures/data/storage-handlers";
import { installBackupsStreams } from "../fixtures/data/storage-streams";
import { exportScreen } from "../harness";

it("data-storage-iam-keys", async () => {
  await exportScreen({
    id: "data-storage-iam-keys",
    title: "Storage · IAM Keys",
    group: "Data",
    route: "/storage/backups/iam-keys",
    handlers: [...storageDetailHandlers(), ...storageHandlers(), ...managedNodeHandlers()],
    before: installBackupsStreams,
    ready: async () => {
      await waitForPageText("backup-runner", "reporting-readonly");
    },
  });
});
