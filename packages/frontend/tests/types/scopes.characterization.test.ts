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
      "admin:users:impersonate",
      "integrations:gitlab:sandbox:clone",
      "ai:workspace:use",
      "feat:ai:configure",
      "ai:skills:manage",
      "ai:sandbox:use",
      "ai:sandbox:tier:medium",
      "ai:sandbox:tier:high",
      "ai:sandbox:manage",
      "mcp:use",
    ];

    expect(removedValues(TOKEN_SCOPES, API_TOKEN_SCOPES)).toEqual(removed);
    expect(API_TOKEN_SCOPES.every((scope) => TOKEN_SCOPES.includes(scope))).toBe(true);
    expect(API_TOKEN_SCOPES).toEqual(
      TOKEN_SCOPES.filter((scope) => !removed.includes(scope.value))
    );
  });

  it("preserves MCP token filtering and source object identity", () => {
    expect(removedValues(API_TOKEN_SCOPES, MCP_TOKEN_SCOPES)).toEqual([]);
    expect(MCP_TOKEN_SCOPES).toEqual(API_TOKEN_SCOPES);
    expect(MCP_TOKEN_SCOPES.every((scope) => API_TOKEN_SCOPES.includes(scope))).toBe(true);
  });

  it("preserves group-assignable filtering and source object identity", () => {
    expect(removedValues(TOKEN_SCOPES, GROUP_ASSIGNABLE_SCOPES)).toEqual(["admin:system"]);
    expect(GROUP_ASSIGNABLE_SCOPES.every((scope) => TOKEN_SCOPES.includes(scope))).toBe(true);
    expect(GROUP_ASSIGNABLE_SCOPES).toEqual(
      TOKEN_SCOPES.filter((scope) => scope.value !== "admin:system")
    );
  });
});
