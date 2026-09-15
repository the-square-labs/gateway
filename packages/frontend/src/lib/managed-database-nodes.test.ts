import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { makeNode } from "@/test/fixtures";
import {
  DATABASE_BACKUPS_CAPABILITY,
  isDatabaseBackupCandidateNode,
  isManagedDatabaseCandidateNode,
  isManagedStorageCandidateNode,
  listManagedDatabaseCandidateNodes,
  MANAGED_STORAGE_CAPABILITY,
  nodeSupportsCapability,
} from "./managed-database-nodes";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("managed database and storage node candidates", () => {
  it("accepts only true compact capability flags without requiring raw daemon metadata", () => {
    const compact = makeNode({
      type: "storage",
      capabilities: { managedStorageV1: true, databaseBackupsV1: true },
    });
    expect(isManagedStorageCandidateNode(compact)).toBe(true);
    expect(isDatabaseBackupCandidateNode(compact)).toBe(true);
    expect(
      isManagedStorageCandidateNode(
        makeNode({ type: "storage", capabilities: { managedStorageV1: "true" } })
      )
    ).toBe(false);
  });

  it.each([
    400, 403, 503,
  ])("does not hide unrelated storage discovery errors (%s)", async (status) => {
    const error = new ApiRequestError("discovery failed", {
      status,
      code: "VALIDATION_ERROR",
      details: [{ path: "limit", message: "Too large" }],
    });
    vi.spyOn(api, "listNodes").mockImplementation(async (params) => {
      if (params?.type === "storage") throw error;
      return { data: [] } as never;
    });
    await expect(listManagedDatabaseCandidateNodes()).rejects.toBe(error);
  });

  it("retains legacy database nodes when the server does not support the storage type", async () => {
    const node = makeNode({ type: "databases" });
    vi.spyOn(api, "listNodes").mockImplementation(async (params) => {
      if (params?.type === "storage")
        throw new ApiRequestError("invalid type", {
          status: 400,
          code: "VALIDATION_ERROR",
          details: [{ path: "type", message: "Invalid enum value, received 'storage'" }],
        });
      return { data: [node] } as never;
    });
    await expect(listManagedDatabaseCandidateNodes()).resolves.toEqual([node]);
  });

  it("accepts canonical storage and legacy database node types for database workloads", () => {
    expect(isManagedDatabaseCandidateNode({ type: "storage" })).toBe(true);
    expect(isManagedDatabaseCandidateNode({ type: "databases" })).toBe(true);
    expect(isManagedDatabaseCandidateNode({ type: "docker" })).toBe(false);
  });

  it("requires the advertised capability for the matching storage workload", () => {
    const storageNode = makeNode({
      type: "storage",
      capabilities: { capabilities: [MANAGED_STORAGE_CAPABILITY] },
    });
    const upgradedLegacyNode = makeNode({
      type: "databases",
      capabilities: { capabilities: [MANAGED_STORAGE_CAPABILITY] },
    });
    const backupOnlyNode = makeNode({
      type: "databases",
      capabilities: { capabilities: [DATABASE_BACKUPS_CAPABILITY] },
    });

    expect(isManagedStorageCandidateNode(storageNode)).toBe(true);
    expect(isManagedStorageCandidateNode(upgradedLegacyNode)).toBe(true);
    expect(isManagedStorageCandidateNode(backupOnlyNode)).toBe(false);
    expect(isDatabaseBackupCandidateNode(storageNode)).toBe(false);
    expect(isDatabaseBackupCandidateNode(backupOnlyNode)).toBe(true);
  });

  it("rejects generic Docker nodes even when they advertise storage capabilities", () => {
    const dockerNode = makeNode({
      type: "docker",
      capabilities: {
        capabilities: [MANAGED_STORAGE_CAPABILITY, DATABASE_BACKUPS_CAPABILITY],
      },
    });

    expect(isManagedStorageCandidateNode(dockerNode)).toBe(false);
    expect(isDatabaseBackupCandidateNode(dockerNode)).toBe(false);
  });

  it("fails closed for missing or malformed capability metadata", () => {
    expect(nodeSupportsCapability(null, MANAGED_STORAGE_CAPABILITY)).toBe(false);
    expect(nodeSupportsCapability({ capabilities: {} }, MANAGED_STORAGE_CAPABILITY)).toBe(false);
    expect(
      nodeSupportsCapability(
        { capabilities: { capabilities: "managed_storage_v1" } },
        MANAGED_STORAGE_CAPABILITY
      )
    ).toBe(false);
    expect(isManagedStorageCandidateNode(makeNode({ type: "storage" }))).toBe(false);
    expect(isDatabaseBackupCandidateNode(makeNode({ type: "databases" }))).toBe(false);
  });

  it("deduplicates the compatibility queries and lets storage results replace duplicate legacy rows", async () => {
    const legacyDatabaseNode = makeNode({ id: "node-1", type: "databases" });
    const canonicalStorageNode = makeNode({ id: "node-2", type: "storage" });
    const upgradedLegacyStorageNode = makeNode({
      id: "node-1",
      type: "storage",
      capabilities: { capabilities: [MANAGED_STORAGE_CAPABILITY] },
    });
    const listNodes = vi.spyOn(api, "listNodes").mockImplementation(async (params) => {
      if (params?.type === "databases") {
        return { data: [legacyDatabaseNode, canonicalStorageNode] } as never;
      }
      return { data: [upgradedLegacyStorageNode, canonicalStorageNode] } as never;
    });

    const nodes = await listManagedDatabaseCandidateNodes(42);

    expect(listNodes).toHaveBeenNthCalledWith(1, { type: "databases", limit: 42 });
    expect(listNodes).toHaveBeenNthCalledWith(2, { type: "storage", limit: 42 });
    expect(nodes.map((node) => node.id)).toEqual(["node-1", "node-2"]);
    expect(nodes.find((node) => node.id === "node-1")?.type).toBe("storage");
  });

  it("paginates oversized requests with valid node-list pages", async () => {
    const listNodes = vi.spyOn(api, "listNodes").mockImplementation(async (params) => {
      const type = params?.type === "storage" ? "storage" : "databases";
      const page = params?.page ?? 1;
      const count = 100;
      return {
        data: Array.from({ length: count }, (_, index) =>
          makeNode({
            id: `${type}-${page}-${index}`,
            type,
          })
        ),
        page,
        limit: params?.limit ?? 100,
        total: 200,
        totalPages: 2,
      };
    });

    const nodes = await listManagedDatabaseCandidateNodes(200);

    expect(listNodes).toHaveBeenCalledTimes(4);
    expect(listNodes).toHaveBeenCalledWith({ type: "databases", page: 1, limit: 100 });
    expect(listNodes).toHaveBeenCalledWith({ type: "databases", page: 2, limit: 100 });
    expect(listNodes).toHaveBeenCalledWith({ type: "storage", page: 1, limit: 100 });
    expect(listNodes).toHaveBeenCalledWith({ type: "storage", page: 2, limit: 100 });
    expect(nodes).toHaveLength(400);
  });
});
