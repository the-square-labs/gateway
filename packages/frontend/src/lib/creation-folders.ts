import { canCreateInFolder, scopeMatches } from "@/lib/scope-utils";

/** Any folder tree node shape (resource folders, proxy route folders). */
export interface CreationFolderTreeNode {
  id: string;
  name: string;
  children?: readonly CreationFolderTreeNode[];
}

export interface CreationFolderOption {
  id: string;
  name: string;
  depth: number;
}

export interface CreationFolderChoices {
  /** The caller may create at the root ("No folder"). */
  allowRoot: boolean;
  /** Folders the caller may create in, in tree order. */
  folders: CreationFolderOption[];
  /** Initial picker value: root when allowed, the only allowed folder otherwise, else unset. */
  defaultFolderId: string;
}

export function flattenCreationFolders(
  nodes: readonly CreationFolderTreeNode[],
  depth = 0
): CreationFolderOption[] {
  return nodes.flatMap((node) => [
    { id: node.id, name: node.name, depth },
    ...flattenCreationFolders(node.children ?? [], depth + 1),
  ]);
}

/**
 * Destinations a creation picker may offer. Mirrors the backend `hasScopeForCreation`:
 * a broad grant, a grant on the destination node, or a grant on the destination folder.
 */
export function creationFolderChoices(
  scopes: readonly string[],
  baseScope: string,
  folders: readonly CreationFolderOption[],
  nodeId?: string
): CreationFolderChoices {
  const allowRoot = canCreateInFolder(scopes, baseScope, null, nodeId || undefined);
  const allowed = folders.filter((folder) =>
    canCreateInFolder(scopes, baseScope, folder.id, nodeId || undefined)
  );
  return {
    allowRoot,
    folders: allowed,
    defaultFolderId: !allowRoot && allowed.length === 1 ? allowed[0]!.id : "",
  };
}

/** Keeps a picked folder only while it is still an allowed destination. */
export function allowedCreationFolderId(choices: CreationFolderChoices, folderId: string): string {
  if (folderId && choices.folders.some((folder) => folder.id === folderId)) return folderId;
  return choices.defaultFolderId;
}

/**
 * The caller holds a creation grant for some destination (broad, folder or node).
 * Unlike `hasScopeBase`, per-resource grants of a creation scope that doubles as a
 * resource action (for example `ssl:cert:issue:<certId>`) do not count.
 */
export function hasCreationDestination(scopes: readonly string[], baseScope: string): boolean {
  return (
    scopeMatches(scopes, baseScope) ||
    scopes.some(
      (scope) => scope.startsWith(`${baseScope}:folder/`) || scope.startsWith(`${baseScope}:node/`)
    )
  );
}
