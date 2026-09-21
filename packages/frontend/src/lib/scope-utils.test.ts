import { expect, it } from "vitest";
import { buildFinalScopes, parseScopesForForm, scopeMatches } from "./scope-utils";

it("keeps snapshot view and mutation permissions scoped to their VM", () => {
  expect(scopeMatches(["hosting:resources:view"], "hosting:snapshots:view:vm")).toBe(false);
  expect(scopeMatches(["hosting:snapshots:view:vm"], "hosting:snapshots:create:vm")).toBe(false);
  expect(scopeMatches(["hosting:snapshots:create:vm"], "hosting:snapshots:view:vm")).toBe(true);
  expect(scopeMatches(["hosting:snapshots:create:vm"], "hosting:snapshots:view:other")).toBe(false);
  expect(scopeMatches(["hosting:snapshots:create:vm"], "hosting:snapshots:view")).toBe(false);
});

it("keeps a complete scope whole even when its prefix is a resource-scopable scope", () => {
  const scopes = [
    "admin:groups:folders:manage",
    "admin:users:folders:manage",
    "nodes:details:node-1",
  ];
  const parsed = parseScopesForForm(scopes);
  expect(parsed.baseScopes).toEqual([
    "admin:groups:folders:manage",
    "admin:users:folders:manage",
    "nodes:details",
  ]);
  expect(parsed.resources).toEqual({ "nodes:details": ["node-1"] });
  expect(buildFinalScopes(parsed.baseScopes, parsed.resources)).toEqual(scopes);
});
