import { describe, expect, it } from "vitest";
import type { DatabaseConnection } from "@/types";
import { isPrivateManagedDatabase, shouldRefreshDatabaseDetailForEvent } from "./DatabaseDetail";

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
