import { useResourceFolderStore } from "@/stores/resource-folders";
import type { ResourceFolderType } from "@/types";

/**
 * Folders start collapsed unless the operator expanded them before (the store
 * restores that from localStorage when it is created, which is before a
 * screen's `before` runs). Seeds the expanded set directly so folder rows show.
 */
export function expandFolders(type: ResourceFolderType, ids: string[]) {
  try {
    window.localStorage.setItem(`resource-folder-expanded:${type}`, JSON.stringify(ids));
  } catch {}
  useResourceFolderStore.setState((state) => ({
    expandedFolderIdsByType: { ...state.expandedFolderIdsByType, [type]: new Set(ids) },
    savedExpandedFolderIdsByType: { ...state.savedExpandedFolderIdsByType, [type]: new Set(ids) },
  }));
}
