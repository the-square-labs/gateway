import { useFolderStore } from "@/stores/folders";
import { folderIds } from "./data";

/** Both route folders open, as the operator left them (normally restored from localStorage). */
export function expandRouteFolders() {
  const expanded = new Set<string>([folderIds.production, folderIds.internal]);
  useFolderStore.setState({ expandedFolderIds: expanded, savedExpandedFolderIds: expanded });
}
