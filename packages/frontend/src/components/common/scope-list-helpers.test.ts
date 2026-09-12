import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { DEFAULT_GATEWAY_FEATURES, useSystemConfigStore } from "@/stores/system-config";
import { RESOURCE_SCOPABLE_SCOPES, TOKEN_SCOPES } from "@/types";
import {
  allResourcePages,
  canLoadScopeResource,
  folderFamilyForScope,
  getResourceLabel,
  getResourceOptions,
  loadFolderFamily,
  loadScopeResourceCatalog,
  loadScopeResourceList,
  parseScopedSelections,
  reportScopeLoadError,
} from "./scope-list-helpers";

describe("resource restriction mappings", () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: "actor", scopes: TOKEN_SCOPES.map((scope) => scope.value) } as never,
    });
    useSystemConfigStore.setState({
      config: {
        ...useSystemConfigStore.getState().config,
        features: { ...DEFAULT_GATEWAY_FEATURES, loggingEnabled: true },
      },
    });
  });
  it("does not query disabled logging even for an administrator", async () => {
    useSystemConfigStore.setState({
      config: {
        ...useSystemConfigStore.getState().config,
        features: { ...DEFAULT_GATEWAY_FEATURES, loggingEnabled: false },
      },
    });
    const schemas = vi.spyOn(api, "listLoggingSchemaFolders");
    const environments = vi.spyOn(api, "listLoggingEnvironmentFolders");
    const load = vi.fn();
    expect(await loadFolderFamily("logging-schemas")).toEqual([]);
    expect(await loadFolderFamily("logging-environments")).toEqual([]);
    expect(await loadScopeResourceList("logs:schemas:view", load)).toEqual([]);
    expect(schemas).not.toHaveBeenCalled();
    expect(environments).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    schemas.mockRestore();
    environments.mockRestore();
  });
  it("does not request resources outside a restricted user's read permissions", async () => {
    useAuthStore.setState({ user: { id: "actor", scopes: ["admin:users"] } as never });
    const load = vi.fn();
    for (const permission of [
      "nodes:details",
      "proxy:view",
      "databases:view",
      "logs:schemas:view",
      "domains:view",
    ]) {
      expect(await loadScopeResourceList(permission, load)).toEqual([]);
    }
    expect(load).not.toHaveBeenCalled();
    expect(canLoadScopeResource("admin:users")).toBe(true);
  });
  it("limits Docker lookups to the permitted node", () => {
    useAuthStore.setState({
      user: { id: "actor", scopes: ["docker:networks:view:n1/r1"] } as never,
    });
    expect(canLoadScopeResource("docker:networks:view", "n1")).toBe(true);
    expect(canLoadScopeResource("docker:networks:view", "n2")).toBe(false);
  });
  it("retains folder-scoped and implied Docker view access", () => {
    useAuthStore.setState({ user: { scopes: ["docker:networks:edit:n1/r1"] } as never });
    expect(canLoadScopeResource("docker:networks:view", "n1")).toBe(true);
    expect(canLoadScopeResource("docker:networks:view", "n2")).toBe(false);
    useAuthStore.setState({ user: { scopes: ["docker:networks:view:folder/f1"] } as never });
    expect(canLoadScopeResource("docker:networks:view", "n1")).toBe(true);
  });
  it("preserves folder choices for create-only access without requesting resource inventory", async () => {
    useAuthStore.setState({ user: { scopes: ["databases:create:folder/f1"] } as never });
    const folders = vi
      .spyOn(api, "listDatabaseFolders")
      .mockResolvedValue([{ id: "f1", name: "Allowed", children: [] }] as never);
    const inventory = vi.fn();
    expect(await loadFolderFamily("databases")).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "f1" })])
    );
    expect(folders).toHaveBeenCalledOnce();
    expect(await loadScopeResourceList("databases:view", inventory)).toEqual([]);
    expect(inventory).not.toHaveBeenCalled();
    folders.mockRestore();
  });

  it("loads Compose permission folders with the canonical API type and preserves nested folder IDs", async () => {
    useAuthStore.setState({ user: { scopes: ["docker:compose:create:folder/f1"] } as never });
    const folders = vi
      .spyOn(api, "listDockerFolders")
      .mockResolvedValue([
        { id: "f1", name: "Production", children: [{ id: "f2", name: "Analytics", children: [] }] },
      ] as never);
    try {
      expect(await loadFolderFamily("docker-compose")).toEqual([
        { id: "f1", label: "Production", family: "docker-compose", ancestorIds: [] },
        { id: "f2", label: "Production/Analytics", family: "docker-compose", ancestorIds: ["f1"] },
      ]);
      expect(folders).toHaveBeenCalledExactlyOnceWith("compose");
    } finally {
      folders.mockRestore();
    }
  });
  it("keeps expected authorization/feature races quiet but reports real failures", () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => "toast");
    reportScopeLoadError("schemas", { status: 503, code: "LOGGING_DISABLED" });
    reportScopeLoadError("nodes", { status: 403, code: "FORBIDDEN" });
    expect(error).not.toHaveBeenCalled();
    reportScopeLoadError("nodes", new Error("Network failed"));
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
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
