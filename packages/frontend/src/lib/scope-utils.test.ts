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

  it("lets inference users view their own usage without a separate grant", () => {
    expect(scopeMatches(["inference:use"], "inference:usage:view:self")).toBe(true);
    expect(scopeMatches(["inference:usage:view:self"], "inference:use")).toBe(false);
  });

  it("matches Docker node scopes against child resources only on the same node", () => {
    expect(
      scopeMatches(["docker:containers:view:node-1"], "docker:containers:view:node-1/container-1")
    ).toBe(true);
    expect(
      scopeMatches(
        ["docker:containers:view:node-1/container-1"],
        "docker:containers:view:node-1/container-2"
      )
    ).toBe(false);
    expect(scopeMatches(["proxy:view:folder"], "proxy:view:folder/host")).toBe(false);
  });
});
