import { screen, within } from "@testing-library/react";
import { http } from "msw";
import { waitForReveal } from "@/test/reveal";
import { wrapped } from "../handlers";
import { managedNodeHandlers } from "../fixtures/data/database-handlers";
import { waitForPageText } from "../fixtures/data/ready";
import { storageDetailHandlers, storageHandlers } from "../fixtures/data/storage-handlers";
import { installBackupsStreams } from "../fixtures/data/storage-streams";
import { nowIso } from "../fixtures/time";
import { exportScreen } from "../harness";

it("data-storage-iam-key-dialog-created", async () => {
  await exportScreen({
    id: "data-storage-iam-key-dialog-created",
    title: "Storage · Access Key Created",
    group: "Data",
    route: "/storage/backups/iam-keys",
    handlers: [
      http.post("*/api/managed-storage/:id/iam-keys", () =>
        wrapped({
          accessKeyId: "GWEXAMPLEACCESSKEY01",
          secretKey: "example-only-secret-key-00000000000000000000",
          name: "ci-uploads",
          createdAt: nowIso(),
        })
      ),
      ...storageDetailHandlers(),
      ...storageHandlers(),
      ...managedNodeHandlers(),
    ],
    before: installBackupsStreams,
    ready: async () => {
      await waitForPageText("backup-runner");
    },
    interact: async (user) => {
      await user.click(screen.getByRole("button", { name: "Create key" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getAllByRole("textbox")[0], "ci-uploads");
      await user.click(within(dialog).getByRole("button", { name: "Create Key" }));
      await screen.findByRole("dialog", { name: "Access Key Created" });
      await waitForReveal();
    },
    notes: [
      "The one-time result with two values: the access key ID and its secret (placeholders), each in a copy field.",
    ],
  });
});
