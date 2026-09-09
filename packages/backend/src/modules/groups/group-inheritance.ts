import { AppError } from '@/middleware/error-handler.js';

/** Depth counts parent edges: root -> child -> grandchild -> great-grandchild. */
export const MAX_GROUP_INHERITANCE_DEPTH = 3;

export function assertGroupParent(
  groups: readonly { id: string; parentId: string | null }[],
  id: string,
  parentId: string | null
) {
  const parents = new Map(groups.map((group) => [group.id, group.parentId]));
  if (parentId && !parents.has(parentId)) throw new AppError(404, 'PARENT_NOT_FOUND', 'Parent group not found');
  parents.set(id, parentId);
  for (const groupId of parents.keys()) {
    const visited = new Set<string>();
    let current: string | null = groupId;
    let depth = -1;
    while (current !== null) {
      if (visited.has(current))
        throw new AppError(400, 'CYCLE_DETECTED', 'This parent assignment would create a cycle');
      visited.add(current);
      if (++depth > MAX_GROUP_INHERITANCE_DEPTH)
        throw new AppError(400, 'NESTING_TOO_DEEP', 'Groups support up to three levels of inheritance');
      current = parents.get(current) ?? null;
    }
  }
}
