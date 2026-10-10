import { useCallback, useMemo } from "react";
import { useAuthStore } from "@/stores/auth";

const FOLDER_QUALIFIER = ":folder/";

export interface FolderAccess {
  /**
   * The caller sees the list only through grants on some resources or folders (no broad view
   * scope): with one top-most folder that folder works as the root (`applyRootFolderView`).
   */
  limitedToFolders: boolean;
  /** The caller holds a folder grant on this folder (any scope of any list). */
  isGrantedFolder: (folderId: string) => boolean;
  /** Folder management somewhere: broadly, or limited to some folders' subfolders. */
  canManageSomeFolders: boolean;
  /**
   * Folder management inside `parentId` (null = the root): creating a folder there, and renaming,
   * moving or deleting its subfolders. The broad scope allows everywhere; a folder grant allows
   * the granted folder's subtree (the server expands grants to subfolders).
   */
  canManageFolderAt: (parentId: string | null) => boolean;
}

/** Whether `scopes` hold `manageScope` limited to some folders (`<scope>:folder/<id>`). */
function hasFolderManageGrant(scopes: readonly string[], manageScope: string | null) {
  return (
    !!manageScope && scopes.some((scope) => scope.startsWith(`${manageScope}${FOLDER_QUALIFIER}`))
  );
}

/**
 * Folder management somewhere in a list: one of `manageScopes` broadly, or the first one (the
 * folder management scope) limited to some folders. Gates the page's "New folder" action.
 */
export function useCanManageSomeFolders(...manageScopes: string[]): boolean {
  return useAuthStore(
    (state) =>
      manageScopes.some((scope) => state.hasScope(scope)) ||
      hasFolderManageGrant(state.user?.scopes ?? [], manageScopes[0] ?? null)
  );
}

/**
 * Folder access for one foldered list: `viewScope` is the list's view scope (null: the list has
 * no folder grants); `manageScopes[0]` its folder management scope, the rest broad alternatives
 * (for example `admin:system`). No manage scope: management is decided by the page alone.
 */
export function useFolderAccess(viewScope: string | null, ...manageScopes: string[]): FolderAccess {
  const manageScope = manageScopes[0] ?? null;
  const scopes = useAuthStore((state) => state.user?.scopes);
  const hasScope = useAuthStore((state) => state.hasScope);
  const limitedToFolders = useAuthStore(
    (state) => !!viewScope && !state.hasScope(viewScope) && state.hasScopedAccess(viewScope)
  );
  const grantedFolderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const scope of scopes ?? []) {
      const index = scope.indexOf(FOLDER_QUALIFIER);
      if (index > 0) ids.add(scope.slice(index + FOLDER_QUALIFIER.length));
    }
    return ids;
  }, [scopes]);
  const broadManage = manageScopes.some((scope) => hasScope(scope));
  const scopedManage = hasFolderManageGrant(scopes ?? [], manageScope);
  const canManageFolderAt = useCallback(
    (parentId: string | null) =>
      broadManage ||
      (scopedManage &&
        !!parentId &&
        (scopes ?? []).includes(`${manageScope}${FOLDER_QUALIFIER}${parentId}`)),
    [broadManage, manageScope, scopedManage, scopes]
  );
  const isGrantedFolder = useCallback(
    (folderId: string) => grantedFolderIds.has(folderId),
    [grantedFolderIds]
  );
  return {
    limitedToFolders,
    isGrantedFolder,
    canManageSomeFolders: broadManage || scopedManage,
    canManageFolderAt,
  };
}
