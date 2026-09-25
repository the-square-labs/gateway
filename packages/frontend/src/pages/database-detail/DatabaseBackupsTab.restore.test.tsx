import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import { useResourceFolderStore } from "@/stores/resource-folders";
import { makeUser } from "@/test/fixtures";
import type { BackupRun } from "@/types/backups";
import { RestoreDialog } from "./DatabaseBackupsTab";

const FOLDER = {
  id: "folder-1",
  name: "Restores",
  parentId: null,
  sortOrder: 0,
  depth: 0,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  children: [],
};

function withScopes(scopes: string[]) {
  useAuthStore.setState({ user: makeUser({ scopes }), isAuthenticated: true, isLoading: false });
}

beforeEach(() => {
  withScopes(["databases:create"]);
  useResourceFolderStore.setState({
    foldersByType: { ...useResourceFolderStore.getState().foldersByType, database: [FOLDER] },
    loadingByType: { ...useResourceFolderStore.getState().loadingByType, database: false },
    fetchFolders: vi.fn().mockResolvedValue(undefined),
  });
});

function backupRun(overrides: Partial<BackupRun> = {}): BackupRun {
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
    status: "succeeded",
    phase: "done",
    bytes: "1024",
    manifest: null,
    error: null,
    startedAt: "2026-09-20T00:00:00.000Z",
    completedAt: "2026-09-20T00:01:00.000Z",
    artifactsDeletedAt: null,
    createdAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  } as BackupRun;
}

async function fillRequiredFields() {
  fireEvent.click(screen.getByRole("combobox", { name: "Storage node" }));
  fireEvent.click(await screen.findByRole("option", { name: "Storage A" }));
  fireEvent.change(screen.getByLabelText("New managed database name"), {
    target: { value: "Restored orders" },
  });
}

describe("RestoreDialog target database name", () => {
  it("pre-fills the normalized source name and sends it as targetDatabaseName", async () => {
    const onRestore = vi.fn().mockResolvedValue(undefined);
    render(
      <RestoreDialog
        run={backupRun()}
        sourceDatabaseName="my-app"
        onOpenChange={vi.fn()}
        executors={[{ id: "node-1", label: "Storage A" }]}
        onRestore={onRestore}
      />
    );

    expect(screen.getByLabelText("Database name (optional)")).toHaveValue("my_app");
    await fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "Queue restore" }));

    await waitFor(() =>
      expect(onRestore).toHaveBeenCalledWith({
        executorNodeId: "node-1",
        newManagedDatabaseName: "Restored orders",
        targetDatabaseName: "my_app",
      })
    );
  });

  it("rejects a name the backend would refuse", async () => {
    const onRestore = vi.fn().mockResolvedValue(undefined);
    render(
      <RestoreDialog
        run={backupRun({ manifest: { sourceDatabase: "orders" } as BackupRun["manifest"] })}
        onOpenChange={vi.fn()}
        executors={[{ id: "node-1", label: "Storage A" }]}
        onRestore={onRestore}
      />
    );

    const input = screen.getByLabelText("Database name (optional)");
    expect(input).toHaveValue("orders");
    await fillRequiredFields();
    fireEvent.change(input, { target: { value: "1-orders" } });

    expect(screen.getByText(/Use letters, digits and underscores/)).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Queue restore" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue restore" }));
    await waitFor(() =>
      expect(onRestore).toHaveBeenCalledWith({
        executorNodeId: "node-1",
        newManagedDatabaseName: "Restored orders",
      })
    );
  });

  it("hides the database name for Redis backups", () => {
    render(
      <RestoreDialog
        run={backupRun({ engine: "redis" })}
        onOpenChange={vi.fn()}
        executors={[{ id: "node-1", label: "Storage A" }]}
        onRestore={vi.fn()}
      />
    );

    expect(screen.queryByLabelText("Database name (optional)")).not.toBeInTheDocument();
  });
});

describe("RestoreDialog destination folder", () => {
  it("restores a folder-scoped creator into the granted folder", async () => {
    withScopes(["databases:create:folder/folder-1"]);
    const onRestore = vi.fn().mockResolvedValue(undefined);
    render(
      <RestoreDialog
        run={backupRun()}
        onOpenChange={vi.fn()}
        executors={[{ id: "node-1", label: "Storage A" }]}
        onRestore={onRestore}
      />
    );

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Folder" })).toHaveTextContent("Restores")
    );
    await fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "Queue restore" }));

    await waitFor(() =>
      expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ folderId: "folder-1" }))
    );
  });

  it("blocks a restore the caller could not create anywhere", async () => {
    withScopes([]);
    render(
      <RestoreDialog
        run={backupRun()}
        onOpenChange={vi.fn()}
        executors={[{ id: "node-1", label: "Storage A" }]}
        onRestore={vi.fn()}
      />
    );

    await fillRequiredFields();

    expect(screen.getByRole("button", { name: "Queue restore" })).toBeDisabled();
  });
});
