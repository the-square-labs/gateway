import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirm } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import type { BackupManifest, BackupRun } from "@/types/backups";
import type { DatabaseConnection } from "@/types/databases";
import { DatabaseBackupsTab } from "./DatabaseBackupsTab";

vi.mock("@/components/common/ConfirmDialog", () => ({
  confirm: vi.fn(async () => true),
  // Like the real dialog: a throwing action keeps it open (resolves false only on cancel).
  confirmAction: vi.fn(async (_opts: unknown, action: () => Promise<unknown>) => {
    try {
      await action();
      return true;
    } catch {
      return false;
    }
  }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// jsdom has no viewport measurements; render every history row.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 49 })),
    getTotalSize: () => count * 49,
    measure: vi.fn(),
    measureElement: vi.fn(),
  }),
}));

const database = { id: "db-1", name: "orders", type: "postgres" } as unknown as DatabaseConnection;

function run(overrides: Partial<BackupRun> = {}): BackupRun {
  return {
    id: "run-1",
    policyId: "policy-1",
    databaseConnectionId: "db-1",
    destinationId: "dest-1",
    destinationBucket: "backups",
    destinationPrefix: "gateway",
    stagingStorageConnectionId: null,
    stagingBucket: null,
    timezone: "UTC",
    executorNodeId: "node-1",
    direction: "backup",
    engine: "postgres",
    status: "completed",
    phase: "completed",
    bytes: "1024",
    manifest: {
      ownedPrefix: "gateway/run-1",
      artifactKeys: ["gateway/run-1/dump"],
    } as BackupManifest,
    error: null,
    startedAt: "2026-09-20T00:00:00.000Z",
    completedAt: "2026-09-20T00:01:00.000Z",
    artifactsDeletedAt: null,
    createdAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

function renderTab(runs: BackupRun[]) {
  vi.spyOn(api, "listBackupPolicies").mockResolvedValue([]);
  vi.spyOn(api, "listBackupRuns").mockResolvedValue(runs);
  render(
    <DatabaseBackupsTab
      database={database}
      destinations={[]}
      executors={[]}
      canManage
      canRun={false}
      canRestore={false}
    />
  );
}

// Each test starts without the previous test's cached history.
beforeEach(() => api.setCache("database:backups:db-1", undefined));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(confirm).mockClear();
});

describe("DatabaseBackupsTab history removal", () => {
  it("deletes a backup with files only through the explicit delete choice", async () => {
    renderTab([run()]);
    const remove = vi
      .spyOn(api, "deleteBackupHistory")
      .mockResolvedValue({ success: true, artifacts: "deleted" });
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith("db-1", "run-1", { artifacts: "delete" })
    );
    expect(remove).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("offers to forget the entry when storage refuses the file deletion", async () => {
    renderTab([run()]);
    const remove = vi
      .spyOn(api, "deleteBackupHistory")
      .mockRejectedValueOnce(
        new ApiRequestError("Backup Files Could Not Be Deleted: bucket is gone.", {
          status: 502,
          code: "BACKUP_ARTIFACT_DELETE_FAILED",
        })
      )
      .mockResolvedValueOnce({ success: true, artifacts: "kept" });
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(remove).toHaveBeenLastCalledWith("db-1", "run-1", { artifacts: "forget" })
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Backup Files Could Not Be Deleted",
        description: expect.stringContaining("bucket is gone"),
        confirmLabel: "Forget entry",
      })
    );
  });

  it("keeps the entry when the user declines to forget it", async () => {
    renderTab([run()]);
    vi.mocked(confirm).mockResolvedValueOnce(false);
    const remove = vi.spyOn(api, "deleteBackupHistory").mockRejectedValue(
      new ApiRequestError("Backup Files Could Not Be Deleted: denied.", {
        status: 502,
        code: "BACKUP_ARTIFACT_DELETE_FAILED",
      })
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("removes retired history without an artifact choice", async () => {
    renderTab([run({ artifactsDeletedAt: "2026-09-21T00:00:00.000Z" })]);
    const remove = vi
      .spyOn(api, "deleteBackupHistory")
      .mockResolvedValue({ success: true, artifacts: "none" });
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("db-1", "run-1"));
  });
});
