import { api } from "@/services/api";
import type { Node } from "@/types";

/** Nodes allowed to host the existing managed-database runtime. */
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
