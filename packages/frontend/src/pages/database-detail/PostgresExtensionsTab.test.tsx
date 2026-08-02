import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConfirmDialog } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import type { DatabaseConnection, ManagedPostgresExtension } from "@/types";
import { PostgresExtensionsTab } from "./PostgresExtensionsTab";

const database = {
  id: "database-1",
  name: "Orders",
  type: "postgres",
  managed: {
    id: "managed-database-1",
    nodeId: "node-1",
    version: "17.5",
    storageSizeBytes: 1024 ** 3,
    runtimeConfig: { cpuCores: 1, memoryMb: 1024, swapMb: 0 },
    publishedPort: null,
    endpointHost: null,
    status: "ready",
    lastError: null,
  },
} as DatabaseConnection;

const extensions: ManagedPostgresExtension[] = [
  {
    name: "hstore",
    defaultVersion: "1.11",
    installedVersion: null,
    comment: "data type for storing sets of (key, value) pairs",
  },
  {
    name: "uuid-ossp",
    defaultVersion: "1.1",
    installedVersion: null,
    comment: "generate universally unique identifiers",
  },
];

describe("PostgresExtensionsTab", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useConfirmDialog.getState().close();
  });

  it("lists extensions available in the running image with inline versions", async () => {
    vi.spyOn(api, "listManagedPostgresExtensions").mockResolvedValue(extensions);
    render(<PostgresExtensionsTab database={database} canManage />);

    expect(await screen.findByText("hstore")).toBeInTheDocument();
    expect(screen.getByText("v1.11")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Enable" })).toHaveLength(2);
    const search = screen.getByRole("textbox", { name: "Search PostgreSQL extensions" });
    expect(search).toHaveClass("border-0");
    expect(search).toHaveClass("bg-background");
    expect(search.parentElement).toHaveClass("border-b");
  });

  it("searches available extensions and confirms an enable action", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listManagedPostgresExtensions").mockResolvedValue(extensions);
    render(<PostgresExtensionsTab database={database} canManage />);

    await screen.findByText("uuid-ossp");
    await user.type(screen.getByRole("textbox", { name: "Search PostgreSQL extensions" }), "uuid");
    expect(screen.queryByText("pg_stat_statements")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() =>
      expect(useConfirmDialog.getState()).toMatchObject({
        title: "Enable PostgreSQL Extension",
        confirmLabel: "Enable",
      })
    );
  });
});
