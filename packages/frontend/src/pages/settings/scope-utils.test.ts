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
    expect(parseScopesForForm(["proxy:advanced:bypass:host-1"])).toEqual({
      baseScopes: ["proxy:advanced:bypass"],
      resources: { "proxy:advanced:bypass": ["host-1"] },
    });
  });

  it("does not parse exact restrictable scopes as narrower scope resources", () => {
    expect(parseScopesForForm(["proxy:advanced:bypass"])).toEqual({
      baseScopes: ["proxy:advanced:bypass"],
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
    expect(scopeMatches(["proxy:advanced"], "proxy:advanced:bypass")).toBe(false);
    expect(scopeMatches(["proxy:advanced:bypass:host-1"], "proxy:advanced")).toBe(false);
    expect(scopeMatches(["proxy:advanced:bypass"], "proxy:advanced:bypass:host-1")).toBe(true);
    expect(scopeMatches(["proxy:raw:bypass"], "proxy:raw:bypass:host-1")).toBe(true);
    expect(scopeMatches(["proxy:raw:bypass:host-1"], "proxy:raw:bypass:host-1")).toBe(true);
    expect(scopeMatches(["proxy:raw:bypass:host-1"], "proxy:raw:bypass:host-2")).toBe(false);
    expect(scopeMatches(["proxy:raw:bypass:host-1"], "proxy:raw:write:host-1")).toBe(false);
    expect(scopeMatches(["proxy:raw:write:host-1"], "proxy:raw:bypass:host-1")).toBe(false);
  });

  it("lets write scopes satisfy matching read scopes", () => {
    expect(scopeMatches(["settings:gateway:edit"], "settings:gateway:view")).toBe(true);
    expect(scopeMatches(["proxy:edit"], "proxy:view")).toBe(true);
    expect(scopeMatches(["proxy:edit"], "proxy:view")).toBe(true);
    expect(scopeMatches(["databases:query:admin"], "databases:query:read")).toBe(true);
  });

  it("does not let create-only or destructive action scopes satisfy read scopes", () => {
    expect(scopeMatches(["proxy:create"], "proxy:view")).toBe(false);
    expect(scopeMatches(["proxy:delete"], "proxy:view")).toBe(false);
    expect(scopeMatches(["proxy:raw:write"], "proxy:raw:read")).toBe(false);
    expect(scopeMatches(["proxy:raw:write:host-1"], "proxy:raw:read:host-1")).toBe(false);
    expect(scopeMatches(["notifications:webhooks:create"], "notifications:webhooks:view")).toBe(
      false
    );
    expect(scopeMatches(["databases:create"], "databases:view")).toBe(false);
    expect(scopeMatches(["databases:credentials:reveal"], "databases:view")).toBe(false);
    expect(scopeMatches(["databases:credentials:reveal:db-1"], "databases:view:db-1")).toBe(false);
    expect(scopeMatches(["logs:schemas:delete"], "logs:schemas:view")).toBe(false);
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
    expect(deriveAllowedResourceIdsByScope(["proxy:advanced:bypass:host-1"])).toEqual({
      "proxy:advanced:bypass": ["host-1"],
    });
  });

  it("shows a base scope as selectable when the user owns only resource-scoped variants", () => {
    expect(hasSelectableScopeBase(["proxy:view:host-1"], "proxy:view")).toBe(true);
    expect(hasSelectableScopeBase(["proxy:edit"], "proxy:view")).toBe(true);
    expect(hasSelectableScopeBase(["proxy:edit:host-1"], "proxy:view")).toBe(true);
    expect(hasSelectableScopeBase(["proxy:advanced:bypass:host-1"], "proxy:advanced")).toBe(false);
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
    expect(hasScopeBase(["proxy:advanced:bypass:host-1"], "proxy:advanced")).toBe(false);
  });
});
