import { expect, it } from "vitest";
import { scopeMatches } from "./scope-utils";

it("keeps snapshot view and mutation permissions scoped to their VM", () => {
  expect(scopeMatches(["hosting:resources:view"], "hosting:snapshots:view:vm")).toBe(false);
  expect(scopeMatches(["hosting:snapshots:view:vm"], "hosting:snapshots:create:vm")).toBe(false);
  expect(scopeMatches(["hosting:snapshots:create:vm"], "hosting:snapshots:view:vm")).toBe(true);
  expect(scopeMatches(["hosting:snapshots:create:vm"], "hosting:snapshots:view:other")).toBe(false);
  expect(scopeMatches(["hosting:snapshots:create:vm"], "hosting:snapshots:view")).toBe(false);
});
