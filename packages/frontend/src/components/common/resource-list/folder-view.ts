// How a folder tree is presented beyond the stored folders: a caller limited to one folder, and
// the folder opened for someone who has never folded one.

interface FolderViewNode {
  id: string;
  children: FolderViewNode[];
}

/**
 * The folder a folder-limited caller works in: their tree is one chain of folders (ancestors
 * come only to connect the path) down to the first folder that holds resources or branches.
 */
function singleGrantedFolder<T extends FolderViewNode>(
  tree: T[],
  getItems: (folder: T) => unknown[]
): T | null {
  if (tree.length !== 1) return null;
  let folder = tree[0];
  while (getItems(folder).length === 0 && folder.children.length === 1) {
    folder = folder.children[0] as T;
  }
  return folder;
}

/**
 * A caller limited to one folder (nothing ungrouped) sees that folder alone, without the folders
 * above it; without folder management and with no subfolders, just its resources.
 */
export function applySingleFolderView<T extends FolderViewNode, TItem>(
  tree: T[],
  ungrouped: TItem[],
  getItems: (folder: T) => TItem[],
  { limitedToFolders, canManageFolders }: { limitedToFolders: boolean; canManageFolders: boolean }
): { folders: T[]; ungrouped: TItem[] } {
  if (!limitedToFolders || ungrouped.length > 0) return { folders: tree, ungrouped };
  const folder = singleGrantedFolder(tree, getItems);
  if (!folder) return { folders: tree, ungrouped };
  if (!canManageFolders && folder.children.length === 0) {
    return { folders: [], ungrouped: getItems(folder) };
  }
  return { folders: [folder], ungrouped };
}

/** With nothing ungrouped, the first folder starts open until the user folds any folder. */
export function defaultOpenFolderId(
  tree: { id: string }[],
  ungroupedCount: number,
  expansionTouched: boolean
): string | null {
  if (expansionTouched || ungroupedCount > 0) return null;
  return tree[0]?.id ?? null;
}
