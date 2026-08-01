import { describe, expect, it } from "vitest";
import type { ManagedDatabaseCreateInput, Node } from "@/types";
import { canDeployManagedDatabase, managedDatabaseCapacity } from "./managed-database-capacity";

const node = {
  id: "node-1",
  capabilities: { cpuCores: 4 },
  lastHealthReport: {
    diskFreeBytes: 24 * 1024 ** 3,
    systemMemoryAvailableBytes: 3_072 * 1024 ** 2,
    swapTotalBytes: 2_048 * 1024 ** 2,
    swapUsedBytes: 512 * 1024 ** 2,
    diskMounts: [],
  },
} as unknown as Node;

const draft: ManagedDatabaseCreateInput = {
  name: "orders",
  type: "postgres",
  version: "17.5",
  nodeId: node.id,
  storageSizeGb: 10,
  cpuCores: 1,
  memoryMb: 1_024,
  swapMb: 0,
  publishTcp: false,
};

describe("managed database capacity", () => {
  it("derives current node capacity for every managed resource limit", () => {
    expect(managedDatabaseCapacity(node)).toEqual({
      storageSizeGb: 24,
      cpuCores: 4,
      memoryMb: 3_072,
      swapMb: 1_536,
    });
  });

  it("keeps deployment disabled until all required fields and resource limits are valid", () => {
    const capacity = managedDatabaseCapacity(node);

    expect(canDeployManagedDatabase({ ...draft, name: "" }, ["17.5"], capacity)).toBe(false);
    expect(canDeployManagedDatabase({ ...draft, storageSizeGb: 25 }, ["17.5"], capacity)).toBe(
      false
    );
    expect(canDeployManagedDatabase({ ...draft, memoryMb: 3_073 }, ["17.5"], capacity)).toBe(false);
    expect(canDeployManagedDatabase(draft, ["17.5"], capacity)).toBe(true);
  });

  it("requires explicit native ClickHouse publication for a native host port", () => {
    const capacity = managedDatabaseCapacity(node);
    const clickhouse = {
      ...draft,
      type: "clickhouse" as const,
      version: "26.7.1.1315",
      publishTcp: true,
      publishedNativePort: 9000,
    };

    expect(canDeployManagedDatabase(clickhouse, ["26.7.1.1315"], capacity)).toBe(true);
    expect(
      canDeployManagedDatabase(
        { ...clickhouse, publishNativeTcp: false },
        ["26.7.1.1315"],
        capacity
      )
    ).toBe(false);
  });
});
