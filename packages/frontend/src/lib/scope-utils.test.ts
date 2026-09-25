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

it("mirrors the backend storage implications the API authorizes with", () => {
  expect(scopeMatches(["storage:objects:admin:s1"], "storage:objects:write:s1")).toBe(true);
  expect(scopeMatches(["storage:objects:write"], "storage:objects:admin")).toBe(false);
  // Backups use the saved credentials; revealing them is the broader grant.
  expect(scopeMatches(["storage:credentials:reveal:s1"], "storage:credentials:use:s1")).toBe(true);
  expect(scopeMatches(["storage:credentials:reveal:s1"], "storage:credentials:use:s2")).toBe(false);
  expect(scopeMatches(["storage:credentials:use"], "storage:credentials:reveal")).toBe(false);
});
