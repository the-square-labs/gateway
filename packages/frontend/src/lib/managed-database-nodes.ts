import { api } from "@/services/api";
import type { Node } from "@/types";

export const MANAGED_STORAGE_CAPABILITY = "managed_storage_v1";
export const DATABASE_BACKUPS_CAPABILITY = "database_backups_v1";

/** Nodes allowed to host managed database and storage runtimes. */
export async function listManagedDatabaseCandidateNodes(limit = 100): Promise<Node[]> {
  const [databaseResult, storageResult] = await Promise.all([
    api.listNodes({ type: "databases", limit }),
    api.listNodes({ type: "storage", limit }).catch(() => null),
  ]);
  const byID = new Map(databaseResult.data.map((node) => [node.id, node]));
  for (const node of storageResult?.data ?? []) byID.set(node.id, node);
  return [...byID.values()];
}

export function isManagedDatabaseCandidateNode(
  node: Pick<Node, "type"> | null | undefined
): boolean {
  return node?.type === "databases" || node?.type === "storage";
}

export function nodeSupportsCapability(
  node: Pick<Node, "capabilities"> | null | undefined,
  capability: string
): boolean {
  const advertised = node?.capabilities?.capabilities;
  return Array.isArray(advertised) && advertised.includes(capability);
}

export function isManagedStorageCandidateNode(
  node: Pick<Node, "type" | "capabilities"> | null | undefined
): boolean {
  return (
    isManagedDatabaseCandidateNode(node) && nodeSupportsCapability(node, MANAGED_STORAGE_CAPABILITY)
  );
}

export function isDatabaseBackupCandidateNode(
  node: Pick<Node, "type" | "capabilities"> | null | undefined
): boolean {
  return (
    isManagedDatabaseCandidateNode(node) &&
    nodeSupportsCapability(node, DATABASE_BACKUPS_CAPABILITY)
  );
}
