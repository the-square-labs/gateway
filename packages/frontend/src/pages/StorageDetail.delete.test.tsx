import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirm } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import type { ObjectStorageConnection } from "@/types";
import { StorageDetail } from "./StorageDetail";

vi.mock("@/stores/auth", () => ({ useAuthStore: () => ({ hasScope: () => true }) }));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => {} }));
vi.mock("@/components/common/ConfirmDialog", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("./storage-detail/StorageOverviewTab", () => ({ StorageOverviewTab: () => null }));
vi.mock("./storage-detail/StorageHeader", () => ({
  StorageHeader: ({ onRemove }: { onRemove: () => void }) => (
    <button type="button" onClick={onRemove}>
      Remove storage
    </button>
  ),
}));

const storage = {
  id: "s1",
  slug: "s1",
  name: "App Storage",
  provider: "minio",
  healthStatus: "online",
  healthHistory: [],
  tags: [],
} as unknown as ObjectStorageConnection;

function historyExists(historyRecords: number, backupsWithFiles: number) {
  return new ApiRequestError("Storage is referenced by backup history.", {
    status: 409,
    code: "STORAGE_BACKUP_HISTORY_EXISTS",
    details: { historyRecords, backupsWithFiles },
  });
}

async function removeStorage() {
  render(
    <MemoryRouter>
      <StorageDetail resolvedStorageId="s1" />
    </MemoryRouter>
  );
  fireEvent.click(await screen.findByRole("button", { name: "Remove storage" }));
}

beforeEach(() => {
  vi.spyOn(api, "getObjectStorageHealthHistory").mockResolvedValue([]);
  vi.spyOn(api, "createObjectStorageMonitoringStream").mockReturnValue({
    addEventListener: vi.fn(),
    close: vi.fn(),
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(confirm).mockReset();
  vi.mocked(confirm).mockResolvedValue(true);
});

describe("Storage deletion with backup history", () => {
  it("forgets finished backup history only after a second, explicit confirmation", async () => {
    vi.spyOn(api, "getObjectStorage").mockResolvedValue(storage);
    const remove = vi
      .spyOn(api, "deleteObjectStorage")
      .mockRejectedValueOnce(historyExists(2, 1))
      .mockResolvedValueOnce(undefined);
    await removeStorage();
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    expect(remove).toHaveBeenNthCalledWith(1, "s1", undefined);
    expect(remove).toHaveBeenNthCalledWith(2, "s1", { backupHistory: "forget" });
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Forget Backup History?",
        description: expect.stringContaining(
          "2 backup history entries reference this storage, 1 of them with backup files"
        ),
      })
    );
    expect(vi.mocked(confirm).mock.lastCall?.[0].description).toContain("are not deleted");
  });

  it("keeps the storage when the history confirmation is declined", async () => {
    vi.spyOn(api, "getObjectStorage").mockResolvedValue(storage);
    vi.mocked(confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const remove = vi.spyOn(api, "deleteObjectStorage").mockRejectedValue(historyExists(1, 0));
    await removeStorage();
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("tells managed storage users that stored backup files go with the cluster", async () => {
    vi.spyOn(api, "getObjectStorage").mockResolvedValue({
      ...storage,
      managed: { id: "m1", status: "ready" },
    } as unknown as ObjectStorageConnection);
    const remove = vi
      .spyOn(api, "deleteManagedObjectStorage")
      .mockRejectedValueOnce(historyExists(1, 1))
      .mockResolvedValueOnce(undefined);
    await removeStorage();
    await waitFor(() => expect(remove).toHaveBeenLastCalledWith("m1", { backupHistory: "forget" }));
    expect(vi.mocked(confirm).mock.lastCall?.[0].description).toContain(
      "stored in this managed storage are deleted with it"
    );
  });

  it("does not offer to forget history while backup policies still use the storage", async () => {
    vi.spyOn(api, "getObjectStorage").mockResolvedValue(storage);
    const remove = vi.spyOn(api, "deleteObjectStorage").mockRejectedValue(
      new ApiRequestError("Storage is used by backup policies.", {
        status: 409,
        code: "STORAGE_REFERENCED_BY_BACKUPS",
      })
    );
    await removeStorage();
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
