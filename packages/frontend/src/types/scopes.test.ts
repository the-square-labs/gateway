import { describe, expect, it } from "vitest";
import { scopeMatches } from "@/lib/scope-utils";
import {
  AI_SCOPE,
  API_TOKEN_SCOPES,
  GROUP_ASSIGNABLE_SCOPES,
  RESOURCE_SCOPABLE_SCOPES,
  TOKEN_SCOPES,
} from "./scopes";

function scopeValues(scopes: readonly { value: string }[]): string[] {
  return scopes.map((scope) => scope.value);
}

describe("scope constants", () => {
  it("keeps AI and resource-scopable scope contracts stable", () => {
    expect(AI_SCOPE).toBe("feat:ai:use");
    expect(RESOURCE_SCOPABLE_SCOPES).toContain("proxy:view");
    expect(RESOURCE_SCOPABLE_SCOPES).toContain("docker:containers:manage");
    expect(RESOURCE_SCOPABLE_SCOPES).toContain("docker:containers:export");
    expect(RESOURCE_SCOPABLE_SCOPES).toContain("databases:query:admin");
    expect(RESOURCE_SCOPABLE_SCOPES).toContain("logs:read");
    expect(RESOURCE_SCOPABLE_SCOPES).not.toContain("admin:system");
    expect(RESOURCE_SCOPABLE_SCOPES).not.toContain("feat:ai:use");
    expect(RESOURCE_SCOPABLE_SCOPES).not.toContain("nodes:folders:manage");
    expect(RESOURCE_SCOPABLE_SCOPES).not.toContain("databases:folders:manage");
  });

  it("filters API-token scopes more strictly than group-assignable scopes", () => {
    const tokenValues = scopeValues(TOKEN_SCOPES);
    const apiTokenValues = scopeValues(API_TOKEN_SCOPES);
    const groupValues = scopeValues(GROUP_ASSIGNABLE_SCOPES);

    expect(tokenValues).toContain("feat:ai:use");
    expect(tokenValues).not.toContain("inference:use");
    expect(tokenValues).toContain("inference:providers:manage");
    expect(tokenValues).not.toContain("inference:usage:view:self");
    expect(TOKEN_SCOPES.find((scope) => scope.value === "feat:ai:use")?.desc).toContain(
      "Gateway Inference"
    );
    expect(tokenValues).toContain("admin:system");
    expect(tokenValues).toContain("admin:users:impersonate");
    expect(tokenValues).toContain("proxy:raw:write");
    expect(tokenValues).toContain("docker:containers:view");

    expect(apiTokenValues).not.toContain("feat:ai:use");
    expect(apiTokenValues).not.toContain("inference:use");
    expect(apiTokenValues).not.toContain("inference:providers:manage");
    expect(apiTokenValues).not.toContain("admin:system");
    expect(apiTokenValues).not.toContain("admin:users");
    expect(apiTokenValues).not.toContain("admin:users:impersonate");
    expect(apiTokenValues).not.toContain("proxy:raw:write");
    expect(apiTokenValues).not.toContain("nodes:config:edit");
    expect(apiTokenValues).toContain("nodes:files:read");
    expect(apiTokenValues).toContain("nodes:files:write");
    expect(apiTokenValues).toContain("docker:containers:view");
    expect(apiTokenValues).toContain("databases:query:read");

    expect(groupValues).toContain("feat:ai:use");
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
});
