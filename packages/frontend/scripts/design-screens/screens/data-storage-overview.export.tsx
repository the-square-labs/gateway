import { managedNodeHandlers } from "../fixtures/data/database-handlers";
import { waitForPageText } from "../fixtures/data/ready";
import { storageDetailHandlers, storageHandlers } from "../fixtures/data/storage-handlers";
import { installBackupsStreams } from "../fixtures/data/storage-streams";
import { exportScreen } from "../harness";

it("data-storage-overview", async () => {
  await exportScreen({
    id: "data-storage-overview",
    title: "Storage · Overview",
    group: "Data",
    route: "/storage/backups",
    handlers: [...storageDetailHandlers(), ...storageHandlers(), ...managedNodeHandlers()],
    height: 1100,
    before: installBackupsStreams,
    ready: async () => {
      await waitForPageText("Network RX", "TLS Certificate");
    },
    notes: [
      "Overview of the managed SeaweedFS cluster; metric history arrives through a fixture monitoring stream.",
    ],
  });
});
