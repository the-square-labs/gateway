import { describe, expect, it } from "vitest";
import { databaseDeleteConfirmation, hasMoreSqlRows } from "./shared";

describe("databaseDeleteConfirmation", () => {
  it("warns that managed database deletion removes its runtime and storage", () => {
    expect(
      databaseDeleteConfirmation({ name: "Orders", managed: { id: "managed-1" } as never })
    ).toEqual({
      title: "Delete Managed Database",
      description:
        'Permanently delete managed database "Orders"? Its container, network, mounted storage, and disk image will be removed together with the saved connection. All database data will be lost.',
      successMessage: "Managed database deleted",
    });
  });

  it("makes clear that deleting an external connection preserves its database", () => {
    expect(databaseDeleteConfirmation({ name: "Warehouse", managed: undefined })).toEqual({
      title: "Delete Database Connection",
      description:
        'Delete saved connection "Warehouse"? The external database and its data will not be changed.',
      successMessage: "Database connection deleted",
    });
  });
});

describe("hasMoreSqlRows", () => {
  it("stops ClickHouse pagination when the last fetched page is not full", () => {
    expect(
      hasMoreSqlRows({
        loadedRows: 3,
        total: 50,
        totalKind: "approximate",
        pageTruncated: false,
      })
    ).toBe(false);
  });

  it("continues ClickHouse pagination only after a full page", () => {
    expect(
      hasMoreSqlRows({
        loadedRows: 100,
        total: 50,
        totalKind: "approximate",
        pageTruncated: true,
      })
    ).toBe(true);
  });

  it("keeps exact PostgreSQL totals authoritative", () => {
    expect(
      hasMoreSqlRows({
        loadedRows: 100,
        total: 101,
        totalKind: "exact",
        pageTruncated: false,
      })
    ).toBe(true);
  });
});
