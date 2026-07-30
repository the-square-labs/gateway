import { describe, expect, it } from "vitest";
import { canonicalizeScopeSelection, scopeMatches } from "./scope-utils";

describe("canonicalizeScopeSelection", () => {
  it("keeps exact resource permissions and removes variants covered by a broad permission", () => {
    expect(
      canonicalizeScopeSelection([
        "nodes:console:node-2",
        "nodes:console",
        "nodes:console:node-1",
        "nodes:details:node-1",
      ])
    ).toEqual(["nodes:console", "nodes:details:node-1"]);
  });

  it("matches Cloudflare management permissions consistently with the backend", () => {
    expect(scopeMatches(["integrations:cloudflare:manage"], "integrations:cloudflare:view")).toBe(
      true
    );
    expect(
      scopeMatches(["integrations:cloudflare:manage"], "integrations:cloudflare:dns:view")
    ).toBe(true);
  });

  it("lets provider and model managers read the provider metadata required by their UI", () => {
    expect(scopeMatches(["inference:providers:manage"], "inference:providers:view")).toBe(true);
    expect(scopeMatches(["inference:models:manage"], "inference:providers:view")).toBe(true);
  });
});
