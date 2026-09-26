import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Git scope-target endpoints", () => {
  beforeEach(() => {
    api.resetSessionState();
  });

  afterEach(() => {
    api.resetSessionState();
    vi.restoreAllMocks();
  });

  it("searches a GitLab connector's groups and projects", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        groups: [{ id: "123", fullPath: "acme/platform", name: "Platform" }],
        projects: [{ id: "456", pathWithNamespace: "acme/platform/api", name: "api" }],
      })
    );

    const result = await api.searchGitLabScopeTargets("gl-1", "acme plat");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/integrations/gitlab/gl-1/scope-targets?search=acme+plat&limit=50"
    );
    expect(result.groups[0]?.fullPath).toBe("acme/platform");
    expect(result.projects[0]?.pathWithNamespace).toBe("acme/platform/api");
  });

  it("accepts the GitHub search payload inside the usual data envelope", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        data: {
          owners: [{ id: "900", login: "acme", type: "Organization" }],
          repos: [{ id: "1011", fullName: "acme/api" }],
        },
      })
    );

    const result = await api.searchGitHubScopeTargets("gh-1", "");

    expect(result).toEqual({
      owners: [{ id: "900", login: "acme", type: "Organization" }],
      repos: [{ id: "1011", fullName: "acme/api" }],
    });
  });

  it("resolves stored qualifiers of one connector", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        items: [
          { qualifier: "group/123", label: "acme/platform", missing: false },
          { qualifier: "project/999", label: "", missing: true },
        ],
      })
    );

    const items = await api.resolveGitScopeTargets("gitlab", "gl-1", ["group/123", "project/999"]);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://gateway.test");
    expect(url.pathname).toBe("/api/integrations/gitlab/gl-1/scope-targets/resolve");
    expect(url.searchParams.get("ids")).toBe("group/123,project/999");
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ qualifier: "project/999", missing: true });
  });
});
