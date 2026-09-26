import { useMemo } from "react";
import {
  type FolderedListItemKeys,
  type FolderedListStore,
  FolderedResourceListCore,
  type FolderedResourceListViewProps,
} from "@/components/common/resource-list/FolderedResourceListCore";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type { ResourceFolderTreeNode, ResourceFolderType } from "@/types";

export interface FolderedResourceListItem {
  id: string;
  folderId?: string | null;
  sortOrder?: number;
}

interface FolderedResourceListProps<TItem extends FolderedResourceListItem>
  extends Omit<FolderedResourceListViewProps<TItem>, "afterSearch"> {
  resourceType: ResourceFolderType;
  realtimeChannel: string;
}

const EMPTY_FOLDERS: ResourceFolderTreeNode[] = [];
const EMPTY_EXPANDED = new Set<string>();

const getSortOrder = (item: FolderedResourceListItem) => item.sortOrder;
const setSortOrder = (item: FolderedResourceListItem, sortOrder: number) => {
  item.sortOrder = sortOrder;
};
const getItemKey = (item: FolderedResourceListItem) => item.id;

/** A resource list grouped into resource folders (`useResourceFolderStore`), keyed by item id. */
export function FolderedResourceList<TItem extends FolderedResourceListItem>({
  resourceType,
  realtimeChannel,
  ...props
}: FolderedResourceListProps<TItem>) {
  const {
    foldersByType,
    loadingByType,
    expandedFolderIdsByType,
    fetchFolders,
    createFolder,
    renameFolder,
    deleteFolder,
    reorderFolders,
    moveResourcesToFolder,
    reorderResources,
    toggleFolder,
  } = useResourceFolderStore();

  const store = useMemo<FolderedListStore<string>>(
    () => ({
      dndPrefix: resourceType,
      realtimeChannel,
      fetchFolders: () => fetchFolders(resourceType),
      createFolder: (name, parentId) => createFolder(resourceType, name, parentId),
      renameFolder: (id, name) => renameFolder(resourceType, id, name),
      deleteFolder: (id) => deleteFolder(resourceType, id),
      reorderFolders: (items) => reorderFolders(resourceType, items),
      moveItems: (ids, folderId) => moveResourcesToFolder(resourceType, ids, folderId),
      reorderItems: (items) =>
        reorderResources(
          resourceType,
          items.map(({ ref, sortOrder }) => ({ id: ref, sortOrder }))
        ),
      toggleFolder: (id) => toggleFolder(resourceType, id),
    }),
    [
      createFolder,
      deleteFolder,
      fetchFolders,
      moveResourcesToFolder,
      realtimeChannel,
      renameFolder,
      reorderFolders,
      reorderResources,
      resourceType,
      toggleFolder,
    ]
  );

  const keys = useMemo<FolderedListItemKeys<TItem, string>>(
    () => ({
      getItemKey,
      getItemSortableId: (item) => `${resourceType}:${item.id}`,
      getItemRef: getItemKey,
      getSortOrder,
      setSortOrder,
    }),
    [resourceType]
  );

  return (
    <FolderedResourceListCore<TItem, string>
      {...props}
      store={store}
      folderState={{
        folders: foldersByType[resourceType] ?? EMPTY_FOLDERS,
        loading: loadingByType[resourceType],
        expandedFolderIds: expandedFolderIdsByType[resourceType] ?? EMPTY_EXPANDED,
      }}
      keys={keys}
    />
  );
}
