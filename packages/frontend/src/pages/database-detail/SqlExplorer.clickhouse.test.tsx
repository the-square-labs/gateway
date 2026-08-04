import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { api } from "@/services/api";
import { renderWithRouter } from "@/test/render";
import type { DatabaseConnection } from "@/types";
import { SqlExplorer } from "./SqlExplorer";

function makeClickHouseDatabase(): DatabaseConnection {
  return {
    id: "clickhouse-1",
    slug: "analytics",
    name: "Analytics",
    type: "clickhouse",
    description: null,
    tags: [],
    manualSizeLimitMb: null,
    host: "clickhouse.example.test",
    port: 8443,
    databaseName: "analytics",
    username: "default",
    tlsEnabled: true,
    healthStatus: "online",
    lastHealthCheckAt: null,
    lastError: null,
    hasStoredPassword: true,
    config: {
      url: "https://clickhouse.example.test:8443/",
      host: "clickhouse.example.test",
      port: 8443,
      database: "analytics",
      username: "default",
      password: "",
      tlsEnabled: true,
    },
    capabilities: {
      sqlConsole: true,
      commandConsole: false,
      catalogExplorer: true,
      rowInsert: true,
      rowUpdate: true,
      rowDelete: true,
      schemaMutation: false,
      exactRowCount: false,
    },
    createdById: "user-1",
    updatedById: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("SqlExplorer (ClickHouse)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "listSqlNamespaces").mockResolvedValue([
      { name: "system", system: true },
      { name: "analytics", system: false },
    ]);
    vi.spyOn(api, "listSqlObjects").mockResolvedValue([
      {
        name: "events",
        type: "table",
        engine: "MergeTree",
        estimatedRows: 1,
        estimatedBytes: 128,
      },
    ]);
    vi.spyOn(api, "browseSqlRows").mockResolvedValue({
      metadata: {
        provider: "clickhouse",
        namespace: "analytics",
        table: "events",
        objectType: "table",
        engine: "MergeTree",
        columns: [
          {
            name: "event_id",
            dataType: "UInt64",
            nullable: false,
            isPrimaryKey: true,
            hasDefault: false,
          },
          {
            name: "name",
            dataType: "String",
            nullable: false,
            isPrimaryKey: false,
            hasDefault: false,
          },
        ],
        primaryKey: ["event_id"],
        hasPrimaryKey: true,
        sortingKey: "event_id",
        partitionKey: null,
        mutations: {
          rowInsert: true,
          rowUpdate: true,
          rowDelete: true,
          identityColumns: ["event_id"],
          immutableColumns: ["event_id"],
        },
      },
      rows: [{ event_id: "1", name: "signup" }],
      page: 1,
      limit: 100,
      total: 50,
      totalKind: "approximate",
      truncated: false,
    });
  });

  it("uses the shared SQL grid and inserts ClickHouse rows", async () => {
    const user = userEvent.setup();
    const insertSqlRow = vi.spyOn(api, "insertSqlRow").mockResolvedValue({
      success: true,
      affectedRows: 1,
    });
    renderWithRouter(
      <SqlExplorer
        database={makeClickHouseDatabase()}
        canWrite={true}
        canAdmin={false}
        focused={false}
        onToggleFocus={vi.fn()}
      />,
      { path: "/databases/:id", route: "/databases/clickhouse-1" }
    );

    expect(await screen.findByText("analytics.events")).toBeInTheDocument();
    await user.click(await screen.findByTitle("Insert row"));
    const inputs = screen.getAllByRole("textbox");
    await user.type(inputs.at(-2)!, "2");
    await user.type(inputs.at(-1)!, "purchase");
    await user.click(screen.getByRole("button", { name: /save \(1\)/i }));

    await waitFor(() => {
      expect(insertSqlRow).toHaveBeenCalledWith("clickhouse-1", "analytics", "events", {
        event_id: 2,
        name: "purchase",
      });
    });

    expect(screen.queryByText("Read only")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Filter tables")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(api.browseSqlRows).toHaveBeenCalledWith(
        "clickhouse-1",
        expect.objectContaining({ namespace: "analytics", table: "events", page: 1, limit: 100 })
      );
    });
  });

  it("does not keep requesting rows when an approximate total exceeds the loaded page", async () => {
    const browseSqlRows = vi.mocked(api.browseSqlRows);
    renderWithRouter(
      <SqlExplorer
        database={makeClickHouseDatabase()}
        canWrite={true}
        canAdmin={false}
        focused={false}
        onToggleFocus={vi.fn()}
      />,
      { path: "/databases/:id", route: "/databases/clickhouse-1" }
    );

    expect(await screen.findByText("analytics.events")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(browseSqlRows).toHaveBeenCalledTimes(1);
  });

  it("shows the shared empty state for an empty ClickHouse table", async () => {
    vi.mocked(api.browseSqlRows).mockResolvedValue({
      metadata: {
        provider: "clickhouse",
        namespace: "analytics",
        table: "events",
        objectType: "table",
        engine: "MergeTree",
        columns: [
          {
            name: "event_id",
            dataType: "UInt64",
            nullable: false,
            isPrimaryKey: true,
            hasDefault: false,
          },
        ],
        primaryKey: ["event_id"],
        hasPrimaryKey: true,
        sortingKey: "event_id",
        partitionKey: null,
        mutations: {
          rowInsert: true,
          rowUpdate: true,
          rowDelete: true,
          identityColumns: ["event_id"],
          immutableColumns: ["event_id"],
        },
      },
      rows: [],
      page: 1,
      limit: 100,
      total: 0,
      totalKind: "approximate",
      truncated: false,
    });

    renderWithRouter(
      <SqlExplorer
        database={makeClickHouseDatabase()}
        canWrite={true}
        canAdmin={false}
        focused={false}
        onToggleFocus={vi.fn()}
      />,
      { path: "/databases/:id", route: "/databases/clickhouse-1" }
    );

    expect(await screen.findByText("No rows found.")).toBeInTheDocument();
    expect(screen.getByText("analytics.events")).toBeInTheDocument();
    expect(screen.getByTitle("Sort by event_id")).toBeInTheDocument();
  });
});
