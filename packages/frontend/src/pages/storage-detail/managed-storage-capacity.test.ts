import { describe, expect, it } from "vitest";
import type { ManagedObjectStorageCreateInput, Node } from "@/types";
import {
  canDeployManagedStorage,
  managedStorageCapacity,
  managedStorageClusterCapacity,
} from "./managed-storage-capacity";

const GIBIBYTE = 1024 ** 3;

describe("managed storage capacity", () => {
  const draft = {
    name: "assets",
    version: "test",
    nodeId: "n1",
    memberNodeIds: ["n1", "n2", "n3", "n4"],
    storageSizeGb: 32,
    cpuCores: 1,
    memoryMb: 1024,
    swapMb: 0,
    publishedPort: 9000,
  } as ManagedObjectStorageCreateInput;
  function member(id: string, freeGb: number | undefined): Node {
    return {
      id,
      capabilities: { cpuCores: 4 },
      lastHealthReport: {
        systemMemoryAvailableBytes: 4 * GIBIBYTE,
        managedStorageCapacity:
          freeGb === undefined ? undefined : { availableBytes: freeGb * GIBIBYTE },
      },
    } as unknown as Node;
  }

  it("limits distributed storage by the smallest selected member, not the primary", () => {
    const nodes = [member("n1", 64), member("n2", 8), member("n3", 48), member("n4", 64)];
    const capacity = managedStorageClusterCapacity(draft, nodes);
    expect(capacity.maxStorageGb).toBe(8);
    expect(canDeployManagedStorage(draft, ["test"], capacity)).toBe(false);
    expect(canDeployManagedStorage({ ...draft, storageSizeGb: 8 }, ["test"], capacity)).toBe(true);
    expect(
      managedStorageClusterCapacity(
        { ...draft, nodeId: "n4", memberNodeIds: [...draft.memberNodeIds!].reverse() },
        nodes
      )
    ).toEqual(capacity);
  });

  it("blocks when any selected member is unavailable or has unknown storage capacity", () => {
    const nodes = [member("n1", 64), member("n2", 64), member("n3", 64)];
    for (const available of [
      nodes,
      [...nodes, member("n4", undefined)],
      [...nodes, member("n4", 0)],
    ]) {
      expect(
        canDeployManagedStorage(draft, ["test"], managedStorageClusterCapacity(draft, available))
      ).toBe(false);
    }
  });

  it("ignores unselected nodes and preserves single-node capacity", () => {
    const nodes = [member("n1", 64), member("n2", 0)];
    expect(managedStorageClusterCapacity({ nodeId: "n1" }, nodes)).toEqual(
      managedStorageCapacity(nodes[0])
    );
    expect(
      managedStorageClusterCapacity({ nodeId: "n1", memberNodeIds: [] }, nodes).maxStorageGb
    ).toBeUndefined();
  });

  it("uses the configured storage root instead of the VM root filesystem", () => {
    const node = {
      capabilities: { cpuCores: 4 },
      lastHealthReport: {
        diskFreeBytes: 500 * GIBIBYTE,
        systemMemoryAvailableBytes: 4 * GIBIBYTE,
        swapTotalBytes: 2 * GIBIBYTE,
        swapUsedBytes: GIBIBYTE,
        diskMounts: [
          {
            mountPoint: "/",
            filesystem: "ext4",
            device: "/dev/vda1",
            totalBytes: 500 * GIBIBYTE,
            usedBytes: 0,
            freeBytes: 500 * GIBIBYTE,
            usagePercent: 0,
          },
          {
            mountPoint: "/data",
            filesystem: "ext4",
            device: "/dev/vdb1",
            totalBytes: 64 * GIBIBYTE,
            usedBytes: 32 * GIBIBYTE,
            freeBytes: 32 * GIBIBYTE,
            usagePercent: 50,
          },
        ],
        managedStorageCapacity: { storageRoot: "/data", availableBytes: 32 * GIBIBYTE },
      },
    } as unknown as Node;

    expect(managedStorageCapacity(node).maxStorageGb).toBe(32);
  });

  it("keeps capacity unknown and blocks deployment for a legacy daemon without the storage-root metric", () => {
    const node = {
      capabilities: { cpuCores: 4 },
      lastHealthReport: {
        diskFreeBytes: 500 * GIBIBYTE,
        systemMemoryAvailableBytes: 4 * GIBIBYTE,
        swapTotalBytes: 0,
        swapUsedBytes: 0,
        diskMounts: [],
      },
    } as unknown as Node;
    const capacity = managedStorageCapacity(node);
    const draft = {
      name: "assets",
      version: "2025-04-22",
      nodeId: "node-1",
      storageSizeGb: 32,
      cpuCores: 1,
      memoryMb: 1024,
      swapMb: 0,
      publishedPort: 9000,
      sftpEnabled: false,
      ftpEnabled: false,
    } as ManagedObjectStorageCreateInput;

    expect(capacity.maxStorageGb).toBeUndefined();
    expect(canDeployManagedStorage(draft, [draft.version], capacity)).toBe(false);
  });
});
