import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { RESOURCE_SCOPABLE_SCOPES } from "@/types";
import {
  allResourcePages,
  folderFamilyForScope,
  getResourceLabel,
  getResourceOptions,
  loadScopeResourceCatalog,
  parseScopedSelections,
} from "./scope-list-helpers";

describe("resource restriction mappings", () => {
  it("loads all Pages projects and SSL certificates using the API's 100 item limit", async () => {
    const projects = vi
      .spyOn(api, "listPageProjects")
      .mockImplementation(async ({ page, limit } = {}) => {
        expect(limit).toBe(100);
        return {
          data: [{ id: `p${page}`, name: `Project ${page}`, folderId: "f1" }],
          pagination: { totalPages: 2 },
        } as never;
      });
    const certs = vi.spyOn(api, "listSSLCertificates").mockResolvedValue({
      data: [{ id: "c1", name: "Cert" }],
      pagination: { totalPages: 1 },
    } as never);
    const catalog = await loadScopeResourceCatalog(
      [{ value: "pages:view" }, { value: "ssl:cert:view" }] as never,
      []
    );
    expect(catalog.pages?.map((item) => item.id)).toEqual(["p1", "p2"]);
    expect(certs).toHaveBeenCalledWith({ page: 1, limit: 100 });
    expect(catalog.ssl).toEqual([{ id: "c1", label: "Cert", folderId: undefined }]);
    projects.mockRestore();
    certs.mockRestore();
  });
  it("supports both API pagination shapes", async () => {
    expect(await allResourcePages(async (page) => ({ data: [page], totalPages: 3 }))).toEqual([
      1, 2, 3,
    ]);
    expect(
      await allResourcePages(async (page) => ({ data: [page], pagination: { totalPages: 2 } }))
    ).toEqual([1, 2]);
  });
  it("keeps healthy node resources when another node fails, and reports the failure", async () => {
    const networks = vi.spyOn(api, "listDockerNetworks").mockImplementation(async (nodeId) => {
      if (nodeId === "bad") throw new Error("Node offline");
      return [{ scopeResourceId: "net1", name: "Network" }] as never;
    });
    const error = vi.spyOn(toast, "error").mockImplementation(() => "toast");
    const catalog = await loadScopeResourceCatalog(
      [{ value: "docker:networks:view" }] as never,
      [
        { id: "good", hostname: "Good", type: "docker" },
        { id: "bad", hostname: "Bad", type: "docker" },
      ] as never
    );
    expect(catalog["docker-network"]?.map((item) => item.id)).toEqual(["good", "good/net1", "bad"]);
    expect(error).toHaveBeenCalled();
    networks.mockRestore();
    error.mockRestore();
  });
  it("Pages selects Page Projects and never falls back to CAs", () => {
    const ca = { id: "ca-1", commonName: "Root CA" };
    expect(folderFamilyForScope("pages:view")).toBe("pages");
    expect(getResourceOptions("pages:view", [ca] as never)).toEqual([]);
    expect(
      getResourceOptions("pages:view", [ca] as never, [], [], [], [], [], [], [], [], {
        pages: [{ id: "project-1", label: "Site", folderId: "folder-1" }],
      })
    ).toEqual([{ id: "project-1", label: "Site", folderId: "folder-1" }]);
    expect(getResourceLabel("pages:view")).not.toContain("CAs");
  });

  it.each([
    ["docker:containers:create", "docker"],
    ["docker:networks:delete", "docker-network"],
    ["docker:volumes:create", "docker-volume"],
    ["docker:images:pull", "docker-image"],
    ["docker:compose:create", "docker-compose"],
    ["databases:create", "databases"],
    ["pages:create", "pages"],
    ["ssl:cert:issue", "ssl"],
    ["nodes:create", "nodes"],
  ])("maps %s to its own folders", (scope, family) => {
    expect(folderFamilyForScope(scope)).toBe(family);
  });

  it("creation does not offer existing resources as destination grants", () => {
    expect(
      getResourceOptions("pages:create", [], [], [], [], [], [], [], [], [], {
        pages: [{ id: "project-1", label: "Site" }],
      })
    ).toEqual([]);
  });

  it("roundtrips folder, provider, account and node targets without changing bases", () => {
    const scopes = [
      "databases:create:folder/f1",
      "hosting:resources:create:provider/proxmox",
      "hosting:resources:delete:node/n1",
      "hosting:resources:view:account/a1",
    ];
    const parsed = parseScopedSelections(scopes, RESOURCE_SCOPABLE_SCOPES);
    expect(parsed.resources).toEqual({
      "databases:create": ["folder/f1"],
      "hosting:resources:create": ["provider/proxmox"],
      "hosting:resources:delete": ["node/n1"],
      "hosting:resources:view": ["account/a1"],
    });
  });
});
