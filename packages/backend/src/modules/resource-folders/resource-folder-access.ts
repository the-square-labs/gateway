import { hasScope, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';

/**
 * Folder management (`<family>:folders:manage`) is granted broadly or on a folder (`...:folder/<id>`, expanded to
 * the folder's subfolders when scopes are resolved). A grant on folder X manages what is inside X: its subfolders
 * and the placement of resources in it, never X itself and never the top level.
 */
export interface FolderManageAccess {
  scopes: readonly string[];
  manageScope: string;
}

/** Whether the caller manages folders at `parentId` (null: the top level, which needs the broad scope). */
export function canManageFolderAt(scopes: readonly string[], manageScope: string, parentId: string | null): boolean {
  return hasScopeForCreation(scopes, manageScope, parentId);
}

export function assertFolderManage(scopes: readonly string[], manageScope: string, parentId: string | null): void {
  if (canManageFolderAt(scopes, manageScope, parentId)) return;
  throw new AppError(
    403,
    'FORBIDDEN',
    parentId
      ? `Missing ${manageScope} for folder ${parentId}`
      : `Managing top-level folders and ungrouped items requires ${manageScope}`,
    { requiredScope: parentId ? `${manageScope}:folder/${parentId}` : manageScope }
  );
}

/** The folder lookups the per-place checks need (FolderedResourceService and the Ingress route folders). */
export interface FolderPlacementLookup {
  getFolderParentIds(ids: readonly string[]): Promise<Map<string, string | null>>;
  getResourceFolderIds(ids: readonly string[]): Promise<Map<string, string | null>>;
}

const holdsBroadly = (scopes: readonly string[], manageScope: string) => hasScope(scopes, manageScope);

/** Rename or delete folder `folderId`: needs management at its parent. */
export async function assertFolderManageForFolder(
  lookup: Pick<FolderPlacementLookup, 'getFolderParentIds'>,
  scopes: readonly string[],
  manageScope: string,
  folderId: string
): Promise<void> {
  if (holdsBroadly(scopes, manageScope)) return;
  const parentId = (await lookup.getFolderParentIds([folderId])).get(folderId) ?? null;
  assertFolderManage(scopes, manageScope, parentId);
}

/** Reorder folders: needs management at every reordered folder's parent. */
export async function assertFolderManageForFolders(
  lookup: Pick<FolderPlacementLookup, 'getFolderParentIds'>,
  scopes: readonly string[],
  manageScope: string,
  folderIds: readonly string[]
): Promise<void> {
  if (holdsBroadly(scopes, manageScope)) return;
  for (const parentId of new Set((await lookup.getFolderParentIds(folderIds)).values())) {
    assertFolderManage(scopes, manageScope, parentId);
  }
}

/**
 * Move resources into `destinationFolderId` (pass `undefined` for a reorder in place): needs management at the
 * destination and at each resource's current folder (ungrouped resources need the broad scope).
 */
export async function assertFolderManageForResources(
  lookup: Pick<FolderPlacementLookup, 'getResourceFolderIds'>,
  scopes: readonly string[],
  manageScope: string,
  resourceIds: readonly string[],
  destinationFolderId: string | null | undefined
): Promise<void> {
  if (holdsBroadly(scopes, manageScope)) return;
  if (destinationFolderId !== undefined) assertFolderManage(scopes, manageScope, destinationFolderId);
  const current = await lookup.getResourceFolderIds(resourceIds);
  const places = new Set<string | null>(resourceIds.map((id) => current.get(id) ?? null));
  for (const folderId of places) assertFolderManage(scopes, manageScope, folderId);
}
