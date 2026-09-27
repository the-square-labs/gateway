import type { CA } from "@/types";

/** A CA as the CA list shows it, with its nesting under a listed parent CA. */
export type CAListItem = CA & { depth: number };

/**
 * Orders CAs as trees: a CA follows its parent when the parent is listed in the
 * same folder, siblings by their stored order and then name. The foldered list
 * sorts by `sortOrder`, so the tree position is written there.
 */
export function arrangeCATree(cas: CA[]): CAListItem[] {
  const byId = new Map(cas.map((ca) => [ca.id, ca]));
  const childrenByParent = new Map<string, CA[]>();
  const tops: CA[] = [];
  for (const ca of cas) {
    const parent = ca.parentId ? byId.get(ca.parentId) : undefined;
    if (parent && (parent.folderId ?? null) === (ca.folderId ?? null)) {
      childrenByParent.set(parent.id, [...(childrenByParent.get(parent.id) ?? []), ca]);
    } else {
      tops.push(ca);
    }
  }
  const bySiblingOrder = (a: CA, b: CA) =>
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.commonName.localeCompare(b.commonName);
  const rows: CAListItem[] = [];
  const visit = (ca: CA, depth: number) => {
    rows.push({ ...ca, depth, sortOrder: rows.length });
    for (const child of [...(childrenByParent.get(ca.id) ?? [])].sort(bySiblingOrder)) {
      visit(child, depth + 1);
    }
  };
  for (const ca of [...tops].sort(bySiblingOrder)) visit(ca, 0);
  return rows;
}
