import { useMemo } from "react";
import {
  type FolderedListItemKeys,
  type FolderedListStore,
  FolderedResourceListCore,
  type FolderedResourceListViewProps,
} from "@/components/common/resource-list/FolderedResourceListCore";
import { useFolderAccess } from "@/hooks/use-folder-access";
import { hasSavedFolderExpansion, useDockerFolderStore } from "@/stores/docker-folders";
import type { DockerFolderResourceType } from "@/types";

export interface DockerFolderedResourceItem {
  folderId?: string | null;
  folderIsSystem?: boolean;
  folderSortOrder?: number;
  _nodeId?: string;
}

interface DockerFolderedResourceListProps<TItem extends DockerFolderedResourceItem>
  extends Omit<
    FolderedResourceListViewProps<TItem>,
    "systemFolders" | "embedded" | "notifyOnMove"
  > {
  resourceType: Exclude<DockerFolderResourceType, "container">;
  /** The list shows one node: folders stay expanded and empty folders are hidden. */
  fixedNodeId?: string;
  getResourceKey: (item: TItem) => string;
}

interface DockerResourceRef {
  nodeId: string;
  resourceKey: string;
}

const DOCKER_VIEW_SCOPE: Record<Exclude<DockerFolderResourceType, "container">, string> = {
  compose: "docker:compose:view",
  network: "docker:networks:view",
  volume: "docker:volumes:view",
  image: "docker:images:view",
};

const getSortOrder = (item: DockerFolderedResourceItem) => item.folderSortOrder;
const setSortOrder = (item: DockerFolderedResourceItem, sortOrder: number) => {
  item.folderSortOrder = sortOrder;
};
const isItemLocked = (item: DockerFolderedResourceItem) => !!item.folderIsSystem;

/**
 * A per-node Docker resource list grouped into Docker folders
 * (`useDockerFolderStore`). Items are keyed by node and resource key.
 */
export function DockerFolderedResourceList<TItem extends DockerFolderedResourceItem>({
  resourceType,
  fixedNodeId,
  getResourceKey,
  ...props
}: DockerFolderedResourceListProps<TItem>) {
  const {
    foldersByType,
    loadingByType,
    expandedFolderIdsByType,
    fetchFolders,
    createFolder,
    renameFolder,
    deleteFolder,
    moveFolder,
    reorderFolders,
    moveResourcesToFolder,
    reorderResources,
    toggleFolder,
  } = useDockerFolderStore();

  // Visible only through folder grants: one top-most granted folder works as the root.
  // Docker folder management stays global (`docker:folders:manage` spans every Docker list).
  const { limitedToFolders, isGrantedFolder } = useFolderAccess(DOCKER_VIEW_SCOPE[resourceType]);

  const store = useMemo<FolderedListStore<DockerResourceRef>>(
    () => ({
      dndPrefix: `docker-${resourceType}`,
      realtimeChannel: "docker.folder.changed",
      fetchFolders: () => fetchFolders(resourceType),
      createFolder: (name, parentId) => createFolder(name, parentId, resourceType),
      renameFolder: (id, name) => renameFolder(id, name, resourceType),
      deleteFolder: (id) => deleteFolder(id, resourceType),
      moveFolder: (id, parentId) => moveFolder(id, parentId, resourceType),
      reorderFolders: (items) => reorderFolders(items, resourceType),
      moveItems: (refs, folderId) => moveResourcesToFolder(resourceType, refs, folderId),
      reorderItems: (items) =>
        reorderResources(
          resourceType,
          items.map(({ ref, sortOrder }) => ({ ...ref, sortOrder }))
        ),
      toggleFolder: (id) => toggleFolder(id, resourceType),
    }),
    [
      createFolder,
      deleteFolder,
      fetchFolders,
      moveFolder,
      moveResourcesToFolder,
      renameFolder,
      reorderFolders,
      reorderResources,
      resourceType,
      toggleFolder,
    ]
  );

  const keys = useMemo<FolderedListItemKeys<TItem, DockerResourceRef>>(() => {
    const getItemKey = (item: TItem) => `${item._nodeId ?? "node"}:${getResourceKey(item)}`;
    return {
      getItemKey,
      getItemSortableId: getItemKey,
      getItemRef: (item) =>
        item._nodeId ? { nodeId: item._nodeId, resourceKey: getResourceKey(item) } : null,
      getSortOrder,
      setSortOrder,
      onOptimisticMove: (item, folder) => {
        item.folderIsSystem = folder?.isSystem ?? false;
      },
      isItemLocked,
    };
  }, [getResourceKey]);

  return (
    <FolderedResourceListCore<TItem, DockerResourceRef>
      {...props}
      store={store}
      folderState={{
        folders: foldersByType[resourceType],
        loading: loadingByType[resourceType],
        expandedFolderIds: expandedFolderIdsByType[resourceType],
        expansionTouched: hasSavedFolderExpansion(resourceType),
      }}
      keys={keys}
      lockExpanded={!!fixedNodeId}
      limitedToFolders={limitedToFolders}
      isGrantedFolder={isGrantedFolder}
    />
  );
}
