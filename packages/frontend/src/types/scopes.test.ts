import { describe, expect, it } from "vitest";
import { scopeMatches } from "@/lib/scope-utils";
import {
  AI_SCOPE,
  API_TOKEN_SCOPES,
  GROUP_ASSIGNABLE_SCOPES,
  MCP_TOKEN_SCOPES,
  RESOURCE_SCOPABLE_SCOPES,
  TOKEN_SCOPES,
} from "./scopes";

function scopeValues(scopes: readonly { value: string }[]): string[] {
  return scopes.map((scope) => scope.value);
}

describe("scope constants", () => {
  it("keeps AI and resource-scopable scope contracts stable", () => {
    expect(AI_SCOPE).toBe("ai:workspace:use");
    expect(RESOURCE_SCOPABLE_SCOPES).toContain("proxy:view");
    expect(RESOURCE_SCOPABLE_SCOPES).toContain("docker:containers:manage");
    expect(RESOURCE_SCOPABLE_SCOPES).toContain("docker:containers:export");
    expect(RESOURCE_SCOPABLE_SCOPES).toContain("docker:compose:view");
    expect(RESOURCE_SCOPABLE_SCOPES).toContain("docker:compose:manage");
    expect(RESOURCE_SCOPABLE_SCOPES).toContain("databases:query:admin");
    expect(RESOURCE_SCOPABLE_SCOPES).toContain("logs:read");
    expect(RESOURCE_SCOPABLE_SCOPES).not.toContain("admin:system");
    expect(RESOURCE_SCOPABLE_SCOPES).not.toContain("feat:ai:use");
    expect(RESOURCE_SCOPABLE_SCOPES).not.toContain("ai:workspace:use");
    expect(RESOURCE_SCOPABLE_SCOPES).not.toContain("nodes:folders:manage");
    expect(RESOURCE_SCOPABLE_SCOPES).not.toContain("databases:folders:manage");
  });

  it("filters API-token scopes more strictly than group-assignable scopes", () => {
    const tokenValues = scopeValues(TOKEN_SCOPES);
    const apiTokenValues = scopeValues(API_TOKEN_SCOPES);
    const groupValues = scopeValues(GROUP_ASSIGNABLE_SCOPES);

    expect(tokenValues).toContain("ai:workspace:use");
    expect(tokenValues).toContain("feat:ai:use");
    expect(tokenValues).not.toContain("inference:setup");
    expect(tokenValues).not.toContain("inference:use");
    expect(tokenValues).toContain("inference:providers:manage");
    expect(tokenValues).not.toContain("inference:usage:view:self");
    expect(TOKEN_SCOPES.find((scope) => scope.value === "ai:workspace:use")?.desc).toContain(
      "AI Workspace"
    );
    expect(TOKEN_SCOPES.find((scope) => scope.value === "feat:ai:use")?.desc).toContain(
      "Gateway Inference"
    );
    expect(tokenValues).toContain("admin:system");
    expect(tokenValues).toContain("admin:users:impersonate");
    expect(tokenValues).toContain("proxy:raw:write");
    expect(tokenValues).toContain("docker:containers:view");
    expect(tokenValues).toContain("docker:compose:view");
    expect(tokenValues).toContain("docker:compose:manage");
    expect(tokenValues).toContain("docker:registries:view");
    expect(tokenValues).not.toContain("integrations:gitlab:registry:view");
    expect(tokenValues).not.toContain("integrations:cloudflare:dns:view");
    expect(tokenValues).toContain("integrations:cloudflare:view");
    expect(tokenValues).toContain("docker:containers:files:read");
    expect(tokenValues).toContain("docker:containers:files:write");
    expect(tokenValues).not.toContain("docker:containers:files");

    expect(apiTokenValues).not.toContain("ai:workspace:use");
    expect(apiTokenValues).not.toContain("inference:use");
    expect(apiTokenValues).not.toContain("mcp:use");
    expect(apiTokenValues).not.toContain("admin:users:impersonate");
    expect(apiTokenValues).not.toContain("integrations:gitlab:sandbox:clone");
    for (const scope of [
      "feat:ai:use",
      "inference:providers:manage",
      "admin:system",
      "admin:users",
      "admin:groups",
      "settings:gateway:edit",
      "proxy:raw:write",
      "nodes:config:edit",
      "nodes:files:read",
      "nodes:files:write",
      "docker:containers:view",
      "docker:compose:view",
      "databases:query:read",
      "hosting:resources:create",
      "integrations:hosting:manage",
      "integrations:gitlab:manage",
      "integrations:github:manage",
      "integrations:github:system",
      "integrations:git:manage",
      "integrations:git:system",
      "integrations:ssh:manage",
      "integrations:cloudflare:manage",
    ]) {
      expect(apiTokenValues).toContain(scope);
    }

    expect(groupValues).toContain("ai:workspace:use");
    expect(groupValues).toContain("feat:ai:use");
    expect(groupValues).not.toContain("inference:setup");
    expect(groupValues).not.toContain("inference:use");
    expect(groupValues).toContain("inference:providers:manage");
    expect(groupValues).not.toContain("inference:usage:view:self");
    expect(groupValues).toContain("admin:users");
    expect(groupValues).toContain("admin:users:impersonate");
    expect(groupValues).toContain("proxy:raw:write");
    expect(groupValues).not.toContain("admin:system");
    expect(scopeMatches(["admin:users"], "admin:users:impersonate")).toBe(false);
    expect(scopeMatches(["admin:users:impersonate"], "admin:users:impersonate")).toBe(true);
  });

  it("lists the same scopes for Gateway MCP as for API tokens, including connector operations", () => {
    const mcpValues = scopeValues(MCP_TOKEN_SCOPES);

    expect(mcpValues).toEqual(scopeValues(API_TOKEN_SCOPES));
    expect(mcpValues).toContain("nodes:details");
    expect(mcpValues).toEqual(
      expect.arrayContaining([
        "integrations:gitlab:repo:write",
        "integrations:github:manage",
        "integrations:git:manage",
        "integrations:ssh:use",
        "integrations:ssh:manage",
      ])
    );
    expect(mcpValues).not.toContain("integrations:gitlab:sandbox:clone");
  });

  it("delegates connector sync and administration scopes to API and MCP tokens", () => {
    const connectorScopes = [
      "integrations:gitlab:sync",
      "integrations:github:sync",
      "integrations:git:sync",
      "integrations:cloudflare:sync",
      "integrations:gitlab:manage",
      "integrations:github:manage",
      "integrations:git:manage",
      "integrations:cloudflare:manage",
      "integrations:ssh:manage",
    ];

    expect(scopeValues(API_TOKEN_SCOPES)).toEqual(expect.arrayContaining(connectorScopes));
    expect(scopeValues(MCP_TOKEN_SCOPES)).toEqual(expect.arrayContaining(connectorScopes));
  });
});
