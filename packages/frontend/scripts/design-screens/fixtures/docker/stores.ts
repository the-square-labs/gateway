import { useDockerFolderStore } from "@/stores/docker-folders";
import { folderIds } from "./data";

/** The operator keeps both of their own container folders open. */
export function expandContainerFolders() {
  const expanded = new Set([folderIds.app, folderIds.observability]);
  const state = useDockerFolderStore.getState();
  useDockerFolderStore.setState({
    expandedFolderIds: expanded,
    savedExpandedFolderIds: expanded,
    expandedFolderIdsByType: { ...state.expandedFolderIdsByType, container: expanded },
    savedExpandedFolderIdsByType: { ...state.savedExpandedFolderIdsByType, container: expanded },
  });
}
