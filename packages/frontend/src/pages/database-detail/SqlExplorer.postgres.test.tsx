import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { api } from "@/services/api";
import { renderWithRouter } from "@/test/render";
import type { DatabaseConnection, SqlTableMetadata } from "@/types";
import { SqlExplorer } from "./SqlExplorer";

function makeDatabase(): DatabaseConnection {
  return {
    id: "db-1",
    slug: "db-1",
    name: "Main Postgres",
    type: "postgres",
    description: null,
    tags: [],
    manualSizeLimitMb: null,
    host: "localhost",
    port: 5432,
    databaseName: "app",
    username: "app",
    tlsEnabled: false,
    healthStatus: "online",
    lastHealthCheckAt: null,
    lastError: null,
    hasStoredPassword: true,
    config: {
      host: "localhost",
      port: 5432,
      database: "app",
      username: "app",
      password: "",
      sslEnabled: false,
    },
    createdById: "user-1",
    updatedById: null,
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
  };
}

function makeMetadata(overrides: Partial<SqlTableMetadata> = {}): SqlTableMetadata {
  return {
    provider: "postgres",
    namespace: "public",
    table: "users",
    objectType: "table",
    primaryKey: ["id"],
    hasPrimaryKey: true,
    columns: [
      {
        name: "id",
        dataType: "integer",
        nullable: false,
        isPrimaryKey: true,
        hasDefault: true,
      },
      {
        name: "name",
        dataType: "text",
        nullable: false,
        isPrimaryKey: false,
        hasDefault: false,
      },
    ],
    mutations: {
      rowInsert: true,
      rowUpdate: true,
      rowDelete: true,
      identityColumns: ["id"],
      immutableColumns: ["id"],
    },
    ...overrides,
  };
}

describe("SqlExplorer (PostgreSQL)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "listSqlNamespaces").mockResolvedValue([{ name: "public", system: false }]);
    vi.spyOn(api, "listSqlObjects").mockResolvedValue([{ name: "users", type: "table" }]);
    vi.spyOn(api, "browseSqlRows").mockResolvedValue({
      metadata: makeMetadata(),
      rows: [{ id: 1, name: "Alice" }],
      page: 1,
      limit: 100,
      total: 1,
      totalKind: "exact",
      truncated: false,
    });
  });

  it("keeps the table header visible while rows load", async () => {
    const result = {
      metadata: makeMetadata(),
      rows: [{ id: 1, name: "Alice" }],
      page: 1,
      limit: 100,
      total: 1,
      totalKind: "exact" as const,
      truncated: false,
    };
    let resolveRows!: (value: typeof result) => void;
    vi.mocked(api.browseSqlRows).mockReturnValue(
      new Promise((resolve) => {
        resolveRows = resolve;
      })
    );

    renderWithRouter(
      <SqlExplorer
        database={makeDatabase()}
        canWrite={true}
        canAdmin={true}
        focused={false}
        onToggleFocus={vi.fn()}
      />,
      { path: "/databases/:id", route: "/databases/db-1" }
    );

    expect(await screen.findByText("public.users")).toBeInTheDocument();
    expect(screen.getAllByText("Loading table rows...")).toHaveLength(2);

    await act(async () => {
      resolveRows(result);
    });

    expect(await screen.findByText("2 columns · editable grid · 1 rows")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search value")).toBeInTheDocument();
  });

  it("shows the standard empty state without actions for an empty table", async () => {
    vi.mocked(api.browseSqlRows).mockResolvedValue({
      metadata: makeMetadata(),
      rows: [],
      page: 1,
      limit: 100,
      total: 0,
      totalKind: "exact",
      truncated: false,
    });

    renderWithRouter(
      <SqlExplorer
        database={makeDatabase()}
        canWrite={true}
        canAdmin={true}
        focused={false}
        onToggleFocus={vi.fn()}
      />,
      { path: "/databases/:id", route: "/databases/db-1" }
    );

    const emptyMessage = await screen.findByText("No rows found.");
    expect(screen.getByText("public.users")).toBeInTheDocument();
    expect(screen.getByTitle("Sort by id")).toBeInTheDocument();
    expect(emptyMessage.parentElement?.querySelector("a, button")).toBeNull();
  });

  it("disables both selectors and uses the shared empty state when there are no schemas", async () => {
    vi.mocked(api.listSqlNamespaces).mockResolvedValue([]);

    renderWithRouter(
      <SqlExplorer
        database={makeDatabase()}
        canWrite={true}
        canAdmin={true}
        focused={false}
        onToggleFocus={vi.fn()}
      />,
      { path: "/databases/:id", route: "/databases/db-1" }
    );

    const emptyMessage = await screen.findByText("No schemas found.");
    const [schemaSelect, tableSelect] = screen.getAllByRole("combobox");
    expect(schemaSelect).toBeDisabled();
    expect(tableSelect).toBeDisabled();
    expect(emptyMessage.parentElement).toHaveClass("bg-card");
  });

  it("disables the table selector when the selected schema has no tables", async () => {
    vi.mocked(api.listSqlObjects).mockResolvedValue([]);

    renderWithRouter(
      <SqlExplorer
        database={makeDatabase()}
        canWrite={true}
        canAdmin={true}
        focused={false}
        onToggleFocus={vi.fn()}
      />,
      { path: "/databases/:id", route: "/databases/db-1" }
    );

    await screen.findByText("No tables found in public.");
    const [schemaSelect, tableSelect] = screen.getAllByRole("combobox");
    expect(schemaSelect).toBeEnabled();
    expect(tableSelect).toBeDisabled();
  });

  it("saves column type changes from the column dialog", async () => {
    const user = userEvent.setup();
    const updatePostgresColumnType = vi.spyOn(api, "updatePostgresColumnType").mockResolvedValue({
      schema: "public",
      table: "users",
      primaryKey: ["id"],
      hasPrimaryKey: true,
      columns: [
        {
          name: "id",
          dataType: "bigint",
          udtName: "int8",
          udtSchema: "pg_catalog",
          nullable: false,
          isPrimaryKey: true,
          hasDefault: true,
        },
        {
          name: "name",
          dataType: "text",
          udtName: "text",
          udtSchema: "pg_catalog",
          nullable: false,
          isPrimaryKey: false,
          hasDefault: false,
        },
      ],
    });

    renderWithRouter(
      <SqlExplorer
        database={makeDatabase()}
        canWrite={true}
        canAdmin={true}
        focused={false}
        onToggleFocus={vi.fn()}
      />,
      { path: "/databases/:id", route: "/databases/db-1" }
    );

    await screen.findByText("public.users");
    await user.click(await screen.findByTitle("Column types"));
    await screen.findByRole("heading", { name: "Column Types" });

    const typeSelects = screen.getAllByRole("combobox");
    fireEvent.click(typeSelects[0]);
    fireEvent.click(await screen.findByText("bigint"));
    await user.click(screen.getByRole("button", { name: /save \(1\)/i }));

    await waitFor(() => {
      expect(updatePostgresColumnType).toHaveBeenCalledWith(
        "db-1",
        "public",
        "users",
        "id",
        "bigint"
      );
    });
  });
});
