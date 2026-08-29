import { describe, expect, it } from "vitest";
import {
  API_TOKEN_SCOPES,
  FOLDER_SCOPABLE_SCOPES,
  GROUP_ASSIGNABLE_SCOPES,
  MCP_TOKEN_SCOPES,
  RESOURCE_SCOPABLE_SCOPES,
  TOKEN_SCOPES,
} from "@/types/scopes";

const values = (scopes: readonly { value: string }[]) => scopes.map((scope) => scope.value);

const removedValues = (
  source: readonly { value: string }[],
  derived: readonly { value: string }[]
) => {
  const derivedEntries = new Set(derived);
  return source.filter((scope) => !derivedEntries.has(scope)).map((scope) => scope.value);
};

describe("scope catalog characterization", () => {
  it("keeps resource and folder restrictions anchored to known token scopes", () => {
    const tokenValues = new Set(values(TOKEN_SCOPES));

    expect(RESOURCE_SCOPABLE_SCOPES.every((scope) => tokenValues.has(scope))).toBe(true);
    expect(FOLDER_SCOPABLE_SCOPES.every((scope) => tokenValues.has(scope))).toBe(true);
  });

  it("preserves API token filtering and source object identity", () => {
    const removed = [
      "proxy:advanced:bypass",
      "proxy:maintenance:bypass",
      "proxy:raw:read",
      "proxy:raw:write",
      "proxy:raw:toggle",
      "proxy:raw:bypass",
      "nodes:config:view",
      "nodes:config:edit",
      "admin:users",
      "admin:users:impersonate",
      "admin:groups",
      "admin:system",
      "settings:gateway:view",
      "settings:gateway:edit",
      "integrations:gitlab:manage",
      "integrations:gitlab:system",
      "integrations:github:manage",
      "integrations:github:system",
      "integrations:git:manage",
      "integrations:git:system",
      "integrations:ssh:manage",
      "integrations:cloudflare:manage",
      "ai:workspace:use",
      "feat:ai:use",
      "feat:ai:configure",
      "ai:skills:manage",
      "ai:sandbox:use",
      "ai:sandbox:tier:medium",
      "ai:sandbox:tier:high",
      "ai:sandbox:manage",
      "mcp:use",
      "inference:providers:view",
      "inference:providers:manage",
      "inference:models:manage",
      "inference:limits:manage",
      "inference:usage:view",
    ];

    expect(removedValues(TOKEN_SCOPES, API_TOKEN_SCOPES)).toEqual(removed);
    expect(API_TOKEN_SCOPES.every((scope) => TOKEN_SCOPES.includes(scope))).toBe(true);
    expect(API_TOKEN_SCOPES).toEqual(
      TOKEN_SCOPES.filter((scope) => !removed.includes(scope.value))
    );
  });

  it("preserves MCP token filtering and source object identity", () => {
    const removed = [
      "integrations:gitlab:view",
      "integrations:gitlab:sync",
      "integrations:gitlab:projects:view",
      "integrations:gitlab:repo:read",
      "integrations:gitlab:repo:write",
      "integrations:gitlab:ci:view",
      "integrations:gitlab:ci:edit",
      "integrations:gitlab:variables:view",
      "integrations:gitlab:variables:edit",
      "integrations:gitlab:variables:delete",
      "integrations:gitlab:webhooks:manage",
      "integrations:gitlab:registry:manage",
      "integrations:gitlab:sandbox:clone",
      "integrations:github:view",
      "integrations:git:view",
      "integrations:ssh:view",
      "integrations:ssh:use",
    ];

    expect(removedValues(API_TOKEN_SCOPES, MCP_TOKEN_SCOPES)).toEqual(removed);
    expect(MCP_TOKEN_SCOPES.every((scope) => API_TOKEN_SCOPES.includes(scope))).toBe(true);
    expect(MCP_TOKEN_SCOPES).toEqual(
      API_TOKEN_SCOPES.filter((scope) => !removed.includes(scope.value))
    );
  });

  it("preserves group-assignable filtering and source object identity", () => {
    expect(removedValues(TOKEN_SCOPES, GROUP_ASSIGNABLE_SCOPES)).toEqual(["admin:system"]);
    expect(GROUP_ASSIGNABLE_SCOPES.every((scope) => TOKEN_SCOPES.includes(scope))).toBe(true);
    expect(GROUP_ASSIGNABLE_SCOPES).toEqual(
      TOKEN_SCOPES.filter((scope) => scope.value !== "admin:system")
    );
  });
});
