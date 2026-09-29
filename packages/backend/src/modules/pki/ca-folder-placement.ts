import type { DrizzleExecutor } from '@/db/client.js';
import { certificateAuthorities } from '@/db/schema/index.js';

/**
 * A CA folder holds whole hierarchies: the folder is stored on the root CA, and every intermediate
 * reports its root's folder so lists place the hierarchy as one unit.
 */
type CaNode = { id: string; parentId: string | null };

function rootOf<T extends CaNode>(byId: ReadonlyMap<string, T>, id: string): T | undefined {
  let current = byId.get(id);
  const seen = new Set<string>();
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

async function allCaNodes(db: DrizzleExecutor) {
  const rows = await db
    .select({
      id: certificateAuthorities.id,
      parentId: certificateAuthorities.parentId,
      folderId: certificateAuthorities.folderId,
    })
    .from(certificateAuthorities);
  return new Map(rows.map((row) => [row.id, row]));
}

/** Intermediates of the listed CAs take their root's folder. */
export function withRootFolders<T extends CaNode & { folderId: string | null }>(cas: T[]): T[] {
  const byId = new Map(cas.map((ca) => [ca.id, ca]));
  return cas.map((ca) => (ca.parentId ? { ...ca, folderId: rootOf(byId, ca.id)?.folderId ?? null } : ca));
}

/** The folder of the hierarchy a CA belongs to. */
export async function rootFolderId(db: DrizzleExecutor, ca: CaNode & { folderId: string | null }) {
  if (!ca.parentId) return ca.folderId;
  return rootOf(await allCaNodes(db), ca.id)?.folderId ?? null;
}

/** The root CA of each listed CA; unknown ids are dropped. */
export async function rootCaIds(db: DrizzleExecutor, ids: readonly string[]): Promise<string[]> {
  const byId = await allCaNodes(db);
  return [...new Set(ids.flatMap((id) => rootOf(byId, id)?.id ?? []))];
}
