import type { ManagedObjectStorageCreateInput, Node } from "@/types";

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

export interface ManagedStorageCapacity {
  maxStorageGb?: number;
  maxCpuCores: number;
  maxMemoryMb: number;
  maxSwapMb: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function wholeUnits(bytes: unknown, unit: number): number {
  const value = finiteNumber(bytes);
  return value === undefined || value < 0 ? 0 : Math.floor(value / unit);
}

function tenthsOfUnits(bytes: unknown, unit: number): number {
  const value = finiteNumber(bytes);
  return value === undefined || value < 0 ? 0 : Math.floor((value * 10) / unit) / 10;
}

export function managedStorageCapacity(node: Node | undefined): ManagedStorageCapacity {
  const health = node?.lastHealthReport;
  const storageRootFreeBytes = finiteNumber(health?.managedStorageCapacity?.availableBytes);
  const swapTotalBytes = finiteNumber(health?.swapTotalBytes);
  const swapUsedBytes = finiteNumber(health?.swapUsedBytes);
  const cpuCores = finiteNumber(node?.capabilities.cpuCores);

  return {
    maxStorageGb:
      storageRootFreeBytes === undefined
        ? undefined
        : tenthsOfUnits(storageRootFreeBytes, GIBIBYTE),
    maxCpuCores: cpuCores !== undefined && cpuCores > 0 ? cpuCores : 0,
    maxMemoryMb: wholeUnits(health?.systemMemoryAvailableBytes, MEBIBYTE),
    maxSwapMb:
      swapTotalBytes === undefined || swapUsedBytes === undefined
        ? 0
        : wholeUnits(Math.max(0, swapTotalBytes - swapUsedBytes), MEBIBYTE),
  };
}

/** The same disk size is allocated on every member, so the smallest one is the limit. */
export function managedStorageClusterCapacity(
  draft: Pick<ManagedObjectStorageCreateInput, "nodeId" | "memberNodeIds">,
  nodes: Node[]
): ManagedStorageCapacity {
  const ids = draft.memberNodeIds ?? [draft.nodeId];
  const capacities = ids.map((id) => managedStorageCapacity(nodes.find((node) => node.id === id)));
  if (capacities.length === 0) return managedStorageCapacity(undefined);
  return {
    ...managedStorageCapacity(nodes.find((node) => node.id === draft.nodeId)),
    maxStorageGb: capacities.every((capacity) => capacity.maxStorageGb !== undefined)
      ? Math.min(...capacities.map((capacity) => capacity.maxStorageGb!))
      : undefined,
  };
}

function withinLimit(value: number, maximum: number) {
  return maximum <= 0 || value <= maximum;
}

function withinKnownStorageLimit(value: number, maximum: number | undefined) {
  return maximum !== undefined && value <= maximum;
}

export function canDeployManagedStorage(
  draft: ManagedObjectStorageCreateInput,
  versions: string[],
  capacity: ManagedStorageCapacity
): boolean {
  return (
    draft.name.trim().length > 0 &&
    versions.includes(draft.version) &&
    draft.nodeId.length > 0 &&
    (!draft.memberNodeIds ||
      (draft.memberNodeIds.length >= 4 &&
        new Set(draft.memberNodeIds).size === draft.memberNodeIds.length)) &&
    Number.isFinite(draft.storageSizeGb) &&
    draft.storageSizeGb >= 1 &&
    withinKnownStorageLimit(draft.storageSizeGb, capacity.maxStorageGb) &&
    Number.isFinite(draft.cpuCores) &&
    draft.cpuCores >= 0.1 &&
    withinLimit(draft.cpuCores, capacity.maxCpuCores) &&
    Number.isInteger(draft.memoryMb) &&
    draft.memoryMb >= 256 &&
    withinLimit(draft.memoryMb, capacity.maxMemoryMb) &&
    Number.isInteger(draft.swapMb) &&
    draft.swapMb >= 0 &&
    withinLimit(draft.swapMb, capacity.maxSwapMb) &&
    Number.isInteger(draft.publishedPort) &&
    draft.publishedPort >= 1 &&
    draft.publishedPort <= 65_535 &&
    (!draft.sftpEnabled ||
      (Number.isInteger(draft.sftpPort) &&
        (draft.sftpPort as number) >= 1 &&
        (draft.sftpPort as number) <= 65_535)) &&
    (!draft.ftpEnabled ||
      (Number.isInteger(draft.ftpPort) &&
        (draft.ftpPort as number) >= 1 &&
        (draft.ftpPort as number) <= 65_535 &&
        Number.isInteger(draft.ftpPassivePortStart) &&
        (draft.ftpPassivePortStart as number) >= 1 &&
        (draft.ftpPassivePortStart as number) <= 65_535 &&
        Number.isInteger(draft.ftpPassivePortCount) &&
        (draft.ftpPassivePortCount as number) >= 1 &&
        (draft.ftpPassivePortCount as number) <= 64 &&
        (draft.ftpPassivePortStart as number) + (draft.ftpPassivePortCount as number) - 1 <=
          65_535))
  );
}
