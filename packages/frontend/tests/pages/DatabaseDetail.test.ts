import { describe, expect, it } from "vitest";
import {
  appendDatabaseMetricSnapshot,
  databaseMonitoringCacheKey,
  hasDatabaseScope,
  isPrivateManagedDatabase,
  shouldRefreshDatabaseDetailForEvent,
} from "@/pages/database-detail/database-detail-state";
import type { DatabaseConnection, DatabaseMetricSnapshot } from "@/types";

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

describe("hasDatabaseScope", () => {
  it("accepts global or matching database scope and rejects missing or unrelated access", () => {
    expect(hasDatabaseScope((scope) => scope === "databases:view", "databases:view", "db-1")).toBe(
      true
    );
    expect(
      hasDatabaseScope((scope) => scope === "databases:view:db-1", "databases:view", "db-1")
    ).toBe(true);
    expect(
      hasDatabaseScope((scope) => scope === "databases:view:db-2", "databases:view", "db-1")
    ).toBe(false);
    expect(hasDatabaseScope(() => true, "databases:view")).toBe(false);
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
