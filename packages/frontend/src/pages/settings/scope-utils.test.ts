import { describe, expect, it } from "vitest";
import {
  buildFinalScopes,
  deriveAllowedResourceIdsByScope,
  hasScopeBase,
  hasSelectableScopeBase,
  parseScopesForForm,
  requiresResourceSelection,
  scopeMatches,
} from "@/lib/scope-utils";

describe("scope editor utilities", () => {
  it("uses longest-match parsing for resource-scoped scope values", () => {
    expect(parseScopesForForm(["admin:users:impersonate:user-1"])).toEqual({
      baseScopes: ["admin:users:impersonate"],
      resources: { "admin:users:impersonate": ["user-1"] },
    });
  });

  it("does not parse exact restrictable scopes as narrower scope resources", () => {
    expect(parseScopesForForm(["admin:users:impersonate"])).toEqual({
      baseScopes: ["admin:users:impersonate"],
      resources: {},
    });
  });

  it("keeps broad and resource scopes mutually exclusive when building final scopes", () => {
    expect(
      buildFinalScopes(["proxy:view", "proxy:edit"], {
        "proxy:view": ["host-1"],
        "proxy:edit": ["host-2"],
      })
    ).toEqual(["proxy:edit:host-2", "proxy:view:host-1"]);
  });

  it("allows a broad actor to remove every resource restriction", () => {
    expect(requiresResourceSelection("proxy:view", {}, ["proxy:view"])).toBe(false);
    expect(requiresResourceSelection("proxy:view", {}, [])).toBe(false);
    expect(requiresResourceSelection("proxy:view", { "proxy:view": ["host-1"] }, [])).toBe(true);
  });

  it("does not let overlapping exact scopes imply each other", () => {
    expect(scopeMatches(["admin:users"], "admin:users:impersonate")).toBe(false);
    expect(scopeMatches(["admin:users:impersonate:user-1"], "admin:users")).toBe(false);
    expect(scopeMatches(["proxy:unrestricted"], "proxy:unrestricted:host-1")).toBe(true);
    expect(scopeMatches(["proxy:unrestricted:host-1"], "proxy:unrestricted:host-1")).toBe(true);
    expect(scopeMatches(["proxy:unrestricted:host-1"], "proxy:unrestricted:host-2")).toBe(false);
    expect(scopeMatches(["proxy:unrestricted:host-1"], "proxy:raw:write:host-1")).toBe(false);
    expect(scopeMatches(["proxy:raw:write:host-1"], "proxy:unrestricted:host-1")).toBe(false);
  });

  it("lets write scopes satisfy matching read scopes", () => {
    expect(scopeMatches(["settings:gateway:edit"], "settings:gateway:view")).toBe(true);
    expect(scopeMatches(["proxy:edit"], "proxy:view")).toBe(true);
    expect(scopeMatches(["proxy:edit"], "proxy:view")).toBe(true);
    expect(scopeMatches(["databases:query:admin"], "databases:query:read")).toBe(true);
  });

  it("applies the generated family rule: every action scope satisfies its family view", () => {
    expect(scopeMatches(["proxy:delete"], "proxy:view")).toBe(true);
    expect(scopeMatches(["notifications:webhooks:manage"], "notifications:webhooks:view")).toBe(
      true
    );
    expect(scopeMatches(["databases:credentials:reveal:db-1"], "databases:view:db-1")).toBe(true);
    expect(scopeMatches(["logs:schemas:delete"], "logs:schemas:view")).toBe(true);
    expect(scopeMatches(["docker:tasks:manage"], "docker:tasks")).toBe(true);
    expect(scopeMatches(["docker:compose:manage:node-1"], "docker:compose:view:node-1/p1")).toBe(
      true
    );
    expect(
      scopeMatches(["docker:availability:manage:node-1/c1"], "docker:containers:view:node-1/c1")
    ).toBe(true);
    expect(scopeMatches(["pki:ca:export:ca-1"], "pki:ca:view:ca-1")).toBe(true);
  });

  it("keeps sibling actions, other families, and folder trees apart", () => {
    expect(scopeMatches(["proxy:raw:write"], "proxy:raw:read")).toBe(false);
    expect(scopeMatches(["proxy:raw:write:host-1"], "proxy:raw:read:host-1")).toBe(false);
    expect(scopeMatches(["proxy:templates:manage"], "proxy:view")).toBe(false);
    expect(scopeMatches(["docker:folders:manage"], "docker:containers:view")).toBe(false);
    expect(scopeMatches(["pki:ca:export:ca-1"], "pki:ca:view:ca-2")).toBe(false);
  });

  it("never lets a creation scope reveal existing resources or destinations", () => {
    expect(scopeMatches(["proxy:create"], "proxy:view")).toBe(false);
    expect(scopeMatches(["databases:create"], "databases:view")).toBe(false);
    expect(scopeMatches(["docker:containers:create"], "docker:containers:view:node-1/c1")).toBe(
      false
    );
    expect(
      scopeMatches(["docker:containers:create:node-1"], "docker:containers:view:node-1/c1")
    ).toBe(false);
    expect(hasScopeBase(["databases:create:folder/f1"], "databases:view")).toBe(false);
    expect(scopeMatches(["proxy:create:node/n1"], "proxy:view:node/n1")).toBe(false);
    expect(scopeMatches(["acl:create"], "acl:view")).toBe(false);
    expect(scopeMatches(["proxy:maintenance:bypass"], "proxy:view")).toBe(false);
  });

  it("keeps write-to-read implications inside the same resource boundary", () => {
    expect(scopeMatches(["proxy:edit:host-1"], "proxy:view:host-1")).toBe(true);
    expect(scopeMatches(["proxy:edit:host-1"], "proxy:view:host-2")).toBe(false);
    expect(scopeMatches(["proxy:edit:host-1"], "proxy:view")).toBe(false);
    expect(scopeMatches(["databases:query:admin:db-1"], "databases:query:write:db-1")).toBe(true);
    expect(scopeMatches(["databases:query:read:db-1"], "databases:view:db-1")).toBe(true);
    expect(scopeMatches(["logs:environments:edit:env-1"], "logs:environments:view:env-1")).toBe(
      true
    );
    expect(scopeMatches(["databases:query:admin:db-1"], "databases:query:write")).toBe(false);
  });

  it("derives resource ids with longest-match parsing", () => {
    expect(deriveAllowedResourceIdsByScope(["admin:users:impersonate:user-1"])).toEqual({
      "admin:users:impersonate": ["user-1"],
    });
  });

  it("shows a base scope as selectable when the user owns only resource-scoped variants", () => {
    expect(hasSelectableScopeBase(["proxy:view:host-1"], "proxy:view")).toBe(true);
    expect(hasSelectableScopeBase(["proxy:edit"], "proxy:view")).toBe(true);
    expect(hasSelectableScopeBase(["proxy:edit:host-1"], "proxy:view")).toBe(true);
    expect(hasSelectableScopeBase(["admin:users:impersonate:user-1"], "admin:users")).toBe(false);
  });

  it("derives resource ids through implied scope relationships", () => {
    expect(deriveAllowedResourceIdsByScope(["proxy:edit:host-1"])).toMatchObject({
      "proxy:view": ["host-1"],
    });
    expect(deriveAllowedResourceIdsByScope(["databases:query:read:db-1"])).toMatchObject({
      "databases:view": ["db-1"],
    });
    expect(deriveAllowedResourceIdsByScope(["logs:environments:edit:env-1"])).toMatchObject({
      "logs:environments:view": ["env-1"],
    });
    expect(deriveAllowedResourceIdsByScope(["logs:schemas:edit:schema-1"])).toMatchObject({
      "logs:schemas:view": ["schema-1"],
    });
  });

  it("matches resource-scoped write access as scoped read access", () => {
    expect(hasScopeBase(["proxy:edit:host-1"], "proxy:view")).toBe(true);
    expect(hasScopeBase(["admin:users:impersonate:user-1"], "admin:users")).toBe(false);
  });
});
