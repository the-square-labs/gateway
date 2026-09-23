import { describe, expect, it } from "vitest";
import {
  MANAGED_DATABASE_NAME_PATTERN,
  normalizeManagedDatabaseName,
} from "./managed-database-name";

describe("normalizeManagedDatabaseName", () => {
  it.each([
    ["my-app", "my_app"],
    ["orders", "orders"],
    ["2024_sales", "_2024_sales"],
    [" billing.db ", "billing_db"],
    ["a".repeat(80), "a".repeat(63)],
  ])("normalizes %s to %s", (input, expected) => {
    const name = normalizeManagedDatabaseName(input);
    expect(name).toBe(expected);
    expect(MANAGED_DATABASE_NAME_PATTERN.test(name)).toBe(true);
  });

  it.each([undefined, null, "", "---"])("falls back to app for %s", (input) => {
    expect(normalizeManagedDatabaseName(input)).toBe("app");
  });
});
