import { useMemo } from "react";
import {
  type FolderedListItemKeys,
  type FolderedListStore,
  FolderedResourceListCore,
  type FolderedResourceListViewProps,
} from "@/components/common/resource-list/FolderedResourceListCore";
import { useLimitedToFolders } from "@/hooks/use-limited-to-folders";
import { hasSavedFolderExpansion, useResourceFolderStore } from "@/stores/resource-folders";
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

/** The view scope of each list; held broadly it shows every folder. */
const VIEW_SCOPE: Record<Exclude<ResourceFolderType, `hosting-snapshot:${string}`>, string> = {
  node: "nodes:details",
  domain: "domains:view",
  "ssl-certificate": "ssl:cert:view",
  "pki-ca": "pki:ca:view",
  "pki-certificate": "pki:cert:view",
  "pki-template": "pki:templates:view",
  "nginx-template": "proxy:templates:view",
  database: "databases:view",
  storage: "storage:view",
  "logging-environment": "logs:environments:view",
  "logging-schema": "logs:schemas:view",
  "admin-user": "admin:users",
  "admin-group": "admin:groups",
  "pages-project": "pages:view",
};

/** Snapshot grants name the hosting resource, which shows all of its snapshot folders. */
function viewScopeOf(type: ResourceFolderType): string | null {
  return type.startsWith("hosting-snapshot:")
    ? null
    : VIEW_SCOPE[type as Exclude<ResourceFolderType, `hosting-snapshot:${string}`>];
}

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

  // Visible only through folder grants: one granted folder is shown on its own.
  const limitedToFolders = useLimitedToFolders(viewScopeOf(resourceType));

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
        expansionTouched: hasSavedFolderExpansion(resourceType),
      }}
      keys={keys}
      limitedToFolders={limitedToFolders}
    />
  );
}
