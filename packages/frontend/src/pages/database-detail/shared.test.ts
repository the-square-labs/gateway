import { describe, expect, it } from "vitest";
import { hasMoreSqlRows } from "./shared";

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
