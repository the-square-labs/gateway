import { describe, expect, it } from "vitest";
import { builtinGroupSortOrder } from "./admin-groups-helpers";

describe("builtin group display order", () => {
  it("orders groups by authority rather than alphabetically", () => {
    const names = ["admin", "guest", "operator", "system-admin", "viewer"];
    expect(names.sort((a, b) => builtinGroupSortOrder(a) - builtinGroupSortOrder(b))).toEqual([
      "system-admin",
      "admin",
      "operator",
      "viewer",
      "guest",
    ]);
  });

  it("places unknown builtin names after established groups", () => {
    expect(builtinGroupSortOrder("future-group")).toBeGreaterThan(builtinGroupSortOrder("guest"));
  });
});
