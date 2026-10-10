// How a folder tree is presented beyond the stored folders: a caller limited to one folder works
// in it as the root, and the folder opened for someone who has never folded one.

interface FolderViewNode {
  id: string;
  children: FolderViewNode[];
}

/**
 * The folder a folder-limited caller works in: their tree is one chain of folders (ancestors
 * come only to connect the path) down to the first granted folder, or without a known grant the
 * first folder that holds resources or branches.
 */
function topGrantedFolder<T extends FolderViewNode>(
  tree: T[],
  getItems: (folder: T) => unknown[],
  isGrantedFolder: (id: string) => boolean
): T | null {
  if (tree.length !== 1) return null;
  let folder = tree[0];
  while (
    !isGrantedFolder(folder.id) &&
    getItems(folder).length === 0 &&
    folder.children.length === 1
  ) {
    folder = folder.children[0] as T;
  }
  return folder;
}

const noGrantedFolders = () => false;

/**
 * A caller limited to one top-most folder (nothing ungrouped) works in that folder as the root:
 * its resources are listed at the top level and its subfolders as top-level folders. `root` is
 * that folder (new top-level folders go inside it), or null for the normal tree.
 */
export function applyRootFolderView<T extends FolderViewNode, TItem>(
  tree: T[],
  ungrouped: TItem[],
  getItems: (folder: T) => TItem[],
  {
    limitedToFolders,
    isGrantedFolder = noGrantedFolders,
  }: { limitedToFolders: boolean; isGrantedFolder?: (id: string) => boolean }
): { folders: T[]; ungrouped: TItem[]; root: T | null } {
  if (!limitedToFolders || ungrouped.length > 0) return { folders: tree, ungrouped, root: null };
  const root = topGrantedFolder(tree, getItems, isGrantedFolder);
  if (!root) return { folders: tree, ungrouped, root: null };
  return { folders: root.children as T[], ungrouped: getItems(root), root };
}

/** Deepest folder depth (0-based) the server allows. */
const MAX_FOLDER_DEPTH = 2;

interface DepthNode {
  id: string;
  depth: number;
  children: DepthNode[];
}

function findNode(tree: DepthNode[], id: string): DepthNode | null {
  for (const node of tree) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

function subtreeHeight(folder: DepthNode): number {
  return folder.children.reduce((max, child) => Math.max(max, 1 + subtreeHeight(child)), 0);
}

function containsFolder(folder: DepthNode, id: string): boolean {
  return folder.id === id || folder.children.some((child) => containsFolder(child, id));
}

/**
 * Whether folder `movingId` may move under `parentId` (null = top level), as the server checks it:
 * not into itself or its subfolders, and within the nesting limit with its subfolders.
 */
export function canMoveFolderInto(
  tree: DepthNode[],
  movingId: string,
  parentId: string | null
): boolean {
  const moving = findNode(tree, movingId);
  if (!moving) return false;
  if (parentId === null) return subtreeHeight(moving) <= MAX_FOLDER_DEPTH;
  const parent = findNode(tree, parentId);
  if (!parent || containsFolder(moving, parentId)) return false;
  return parent.depth + 1 + subtreeHeight(moving) <= MAX_FOLDER_DEPTH;
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
