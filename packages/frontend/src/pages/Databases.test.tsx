import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  DatabaseConnection,
  ManagedDatabaseCreateInput,
  Node,
  ResourceFolderTreeNode,
} from "@/types";
import {
  applyDatabaseHealthSample,
  canRenderDatabaseRowsWithNodeAppearance,
  ManagedDatabaseCreateForm,
} from "./Databases";
import type { ManagedDatabaseCapacity } from "./database-detail/managed-database-capacity";

const database = (overrides: Partial<DatabaseConnection> = {}) =>
  ({
    id: "db-1",
    name: "Primary",
    type: "postgres",
    healthStatus: "unknown",
    lastHealthCheckAt: null,
    ...overrides,
  }) as DatabaseConnection;

const managedDraft: ManagedDatabaseCreateInput = {
  name: "Test database",
  type: "postgres",
  version: "17",
  nodeId: "node-1",
  storageSizeGb: 10,
  cpuCores: 1,
  memoryMb: 1024,
  swapMb: 0,
  tags: [],
  publishTcp: false,
  tlsEnabled: true,
};

function FolderForm({
  loading = false,
  step = 1,
  onFolderChange = (_id: string) => {},
}: {
  loading?: boolean;
  step?: 1 | 2;
  onFolderChange?: (id: string) => void;
}) {
  const [folderId, setFolderId] = useState("");
  return (
    <ManagedDatabaseCreateForm
      draft={managedDraft}
      nodes={[]}
      catalog={[]}
      capacity={{} as ManagedDatabaseCapacity}
      step={step}
      onChange={() => {}}
      folderId={folderId}
      foldersLoading={loading}
      folderOptions={
        [
          {
            id: "parent",
            name: "Production",
            depth: 0,
            children: [],
            parentId: null,
            sortOrder: 0,
            createdAt: "2026-09-11T00:00:00Z",
            updatedAt: "2026-09-11T00:00:00Z",
          },
          {
            id: "child",
            name: "Analytics",
            depth: 1,
            children: [],
            parentId: "parent",
            sortOrder: 0,
            createdAt: "2026-09-11T00:00:00Z",
            updatedAt: "2026-09-11T00:00:00Z",
          },
        ] satisfies ResourceFolderTreeNode[]
      }
      onFolderChange={(id) => {
        setFolderId(id);
        onFolderChange(id);
      }}
    />
  );
}

describe("managed database folder field", () => {
  it("uses the same vertical field layout and grid as Name without a settings row", () => {
    render(<FolderForm />);
    const folder = screen.getByRole("combobox", { name: "Folder" });
    const name = screen.getByLabelText("Name");
    expect(folder.parentElement?.className).toBe(name.parentElement?.className);
    expect(folder.parentElement?.parentElement).toBe(name.parentElement?.parentElement);
    expect(folder).toHaveClass("w-full");
    expect(screen.queryByText("Optional organization folder")).not.toBeInTheDocument();
  });

  it("keeps nested folder selection and No folder reset controlled by the parent", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    render(<FolderForm onFolderChange={change} />);
    await user.click(screen.getByRole("combobox", { name: "Folder" }));
    await user.click(await screen.findByRole("option", { name: "Analytics" }));
    expect(change).toHaveBeenLastCalledWith("child");
    expect(screen.getByRole("combobox", { name: "Folder" })).toHaveTextContent("Analytics");
    await user.click(screen.getByRole("combobox", { name: "Folder" }));
    await user.click(await screen.findByRole("option", { name: "No folder" }));
    expect(change).toHaveBeenLastCalledWith("");
    expect(screen.getByRole("combobox", { name: "Folder" })).toHaveTextContent("No folder");
  });

  it("disables selection while folders load", () => {
    render(<FolderForm loading />);
    expect(screen.getByRole("combobox", { name: "Folder" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Folder" })).toHaveAttribute("aria-busy", "true");
  });

  it("does not render the folder selector on the resource step", () => {
    render(<FolderForm step={2} />);
    expect(screen.queryByRole("combobox", { name: "Folder" })).not.toBeInTheDocument();
  });
});

describe("database list state", () => {
  it("applies health samples in place without replacing unrelated rows", () => {
    const untouched = database({ id: "db-2", name: "Replica" });
    const rows = [database(), untouched];

    const next = applyDatabaseHealthSample(rows, {
      id: "db-1",
      action: "health.sampled",
      healthStatus: "online",
      sampledAt: "2026-08-14T12:00:00.000Z",
    });

    expect(next[0]).toMatchObject({
      healthStatus: "online",
      lastHealthCheckAt: "2026-08-14T12:00:00.000Z",
    });
    expect(next[1]).toBe(untouched);
  });

  it("waits for the managed node appearance before rendering cached rows", () => {
    const rows = [
      database({
        managed: { nodeId: "node-1" } as DatabaseConnection["managed"],
      }),
    ];

    expect(canRenderDatabaseRowsWithNodeAppearance(rows, [])).toBe(false);
    expect(canRenderDatabaseRowsWithNodeAppearance(rows, [{ id: "node-1" } as Node])).toBe(true);
    expect(canRenderDatabaseRowsWithNodeAppearance([database()], [])).toBe(true);
  });

  it("keeps tag separators while editing more than one managed database tag", () => {
    function Harness() {
      const [draft, setDraft] = useState<ManagedDatabaseCreateInput>({
        name: "Test database",
        type: "postgres",
        version: "17",
        nodeId: "node-1",
        storageSizeGb: 10,
        cpuCores: 1,
        memoryMb: 1024,
        swapMb: 0,
        tags: [],
        publishTcp: false,
        tlsEnabled: true,
      });

      return (
        <ManagedDatabaseCreateForm
          draft={draft}
          nodes={[]}
          catalog={[]}
          capacity={{} as ManagedDatabaseCapacity}
          step={1}
          onChange={setDraft}
        />
      );
    }

    render(<Harness />);
    const input = screen.getByLabelText("Tags");

    fireEvent.change(input, { target: { value: "team, " } });
    expect(input).toHaveValue("team, ");

    fireEvent.change(input, { target: { value: "team, green:production" } });
    expect(input).toHaveValue("team, green:production");
  });
});
