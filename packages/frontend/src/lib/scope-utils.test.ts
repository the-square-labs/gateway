import { expect, it } from "vitest";
import {
  buildFinalScopes,
  deriveAllowedResourceIdsByScope,
  parseScopesForForm,
  scopeMatches,
} from "./scope-utils";

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

it("parses Git connector, group, project, owner and repository qualifiers", () => {
  const scopes = [
    "integrations:git:repo:write:git-1",
    "integrations:github:repo:read:gh-1/owner/900",
    "integrations:github:repo:read:gh-1/repo/1011",
    "integrations:gitlab:manage:gl-2",
    "integrations:gitlab:sandbox:clone:gl-1/project/456",
    "integrations:gitlab:use:gl-1/group/123",
  ];
  const parsed = parseScopesForForm(scopes);
  expect(parsed.resources).toEqual({
    "integrations:git:repo:write": ["git-1"],
    "integrations:github:repo:read": ["gh-1/owner/900", "gh-1/repo/1011"],
    "integrations:gitlab:manage": ["gl-2"],
    "integrations:gitlab:sandbox:clone": ["gl-1/project/456"],
    "integrations:gitlab:use": ["gl-1/group/123"],
  });
  expect(buildFinalScopes(parsed.baseScopes, parsed.resources)).toEqual(scopes);
});

it("lets a Git connector qualifier cover its targets, and actions imply view per qualifier", () => {
  expect(
    scopeMatches(["integrations:gitlab:use:gl-1"], "integrations:gitlab:use:gl-1/project/4")
  ).toBe(true);
  expect(
    scopeMatches(["integrations:gitlab:use:gl-1"], "integrations:gitlab:use:gl-2/project/4")
  ).toBe(false);
  expect(
    scopeMatches(["integrations:gitlab:use:gl-1/group/1"], "integrations:gitlab:use:gl-1")
  ).toBe(false);
  expect(
    scopeMatches(
      ["integrations:github:repo:write:gh-1/repo/7"],
      "integrations:github:view:gh-1/repo/7"
    )
  ).toBe(true);
});

it("bounds grantable Git qualifiers by what the granting user holds", () => {
  const allowed = deriveAllowedResourceIdsByScope([
    "integrations:gitlab:use:gl-1/group/123",
    "integrations:gitlab:repo:read",
    "integrations:github:repo:write:gh-1",
  ]);
  expect(allowed["integrations:gitlab:use"]).toEqual(["gl-1/group/123"]);
  // Using a target implies viewing that target, not the whole provider.
  expect(allowed["integrations:gitlab:view"]).toEqual(["gl-1/group/123"]);
  expect(allowed["integrations:gitlab:repo:read"]).toBeUndefined();
  expect(allowed["integrations:github:repo:write"]).toEqual(["gh-1"]);
  expect(allowed["integrations:github:view"]).toEqual(["gh-1"]);
  expect(allowed["integrations:git:use"]).toBeUndefined();

  // Administering a connector implies viewing it.
  expect(deriveAllowedResourceIdsByScope(["integrations:git:manage:git-1"])).toMatchObject({
    "integrations:git:manage": ["git-1"],
    "integrations:git:view": ["git-1"],
  });
});
