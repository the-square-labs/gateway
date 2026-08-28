import { describe, expect, it } from "vitest";
import type { DatabaseConnection, DatabaseMetricSnapshot } from "@/types";
import {
  appendDatabaseMetricSnapshot,
  databaseMonitoringCacheKey,
  isPrivateManagedDatabase,
  shouldRefreshDatabaseDetailForEvent,
} from "./DatabaseDetail";

describe("isPrivateManagedDatabase", () => {
  it("does not classify an external database as a private managed database", () => {
    expect(isPrivateManagedDatabase({ managed: undefined } as DatabaseConnection)).toBe(false);
  });

  it("classifies only an unpublished managed database as private", () => {
    expect(
      isPrivateManagedDatabase({ managed: { publishedPort: null } } as DatabaseConnection)
    ).toBe(true);
  });

  it("does not reload the whole detail after an extension action updates its own tab state", () => {
    expect(shouldRefreshDatabaseDetailForEvent("extensions.updated")).toBe(false);
    expect(shouldRefreshDatabaseDetailForEvent("updated")).toBe(true);
  });
});

describe("database monitoring cache", () => {
  it("uses a stable per-database cache key", () => {
    expect(databaseMonitoringCacheKey("database-1")).toBe("database:monitoring:database-1");
  });

  it("keeps only the newest 60 metric snapshots", () => {
    const history = Array.from({ length: 60 }, (_, index) => ({
      timestamp: String(index),
    })) as DatabaseMetricSnapshot[];
    const next = { timestamp: "newest" } as DatabaseMetricSnapshot;

    const updated = appendDatabaseMetricSnapshot(history, next);

    expect(updated).toHaveLength(60);
    expect(updated[0]?.timestamp).toBe("1");
    expect(updated.at(-1)).toBe(next);
  });
});
