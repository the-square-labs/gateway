import { describe, expect, it } from "vitest";
import {
  createReturnNavigationState,
  getReturnNavigationTarget,
  preserveReturnNavigationState,
} from "../../src/lib/return-navigation";

describe("return navigation", () => {
  it("captures the complete current in-app route", () => {
    expect(
      createReturnNavigationState({
        pathname: "/nodes/edge/containers",
        search: "?view=compact",
        hash: "#api",
      })
    ).toEqual({ returnTo: "/nodes/edge/containers?view=compact#api" });
  });

  it("uses only safe in-app return targets", () => {
    expect(getReturnNavigationTarget({ returnTo: "/nodes/edge/containers" }, "/docker")).toBe(
      "/nodes/edge/containers"
    );
    expect(getReturnNavigationTarget({ returnTo: "https://example.com" }, "/docker")).toBe(
      "/docker"
    );
    expect(getReturnNavigationTarget({ returnTo: "//example.com" }, "/docker")).toBe("/docker");
  });

  it("preserves a valid return target while discarding transient route state", () => {
    expect(
      preserveReturnNavigationState({
        returnTo: "/nodes/edge/containers",
        dockerMigration: { id: "migration-1" },
      })
    ).toEqual({ returnTo: "/nodes/edge/containers" });
  });
});
