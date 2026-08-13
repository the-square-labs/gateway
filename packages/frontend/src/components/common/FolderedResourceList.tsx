import { type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { FolderCreateDialog } from "@/components/common/FolderCreateDialog";
import { ResourceListForm } from "@/components/common/ResourceListForm";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useRealtime } from "@/hooks/use-realtime";
import { collectFolderTreeIds } from "@/lib/folder-tree";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type { ResourceFolderTreeNode, ResourceFolderType } from "@/types";

export interface FolderedResourceListItem {
  id: string;
  folderId?: string | null;
  sortOrder?: number;
}

interface FolderTreeNodeWithItems<TItem> extends ResourceFolderTreeNode {
  isSystem?: boolean;
  items: TItem[];
  children: FolderTreeNodeWithItems<TItem>[];
}

interface FolderedResourceListSystemFolder<TItem> {
  id: string;
  name: string;
  items: TItem[];
}

interface FolderedResourceListProps<TItem extends FolderedResourceListItem> {
  resourceType: ResourceFolderType;
  realtimeChannel: string;
  resources: TItem[];
  systemFolders?: FolderedResourceListSystemFolder<TItem>[];
  columns: ResourceListColumn<TItem>[];
  search: {
    search: string;
    onSearchChange: (value: string) => void;
    placeholder: string;
    hasActiveFilters: boolean;
    onReset: () => void;
    onSearchSubmit?: () => void;
    filters?: React.ReactNode;
  };
  loading: boolean;
  loadingLabel: string;
  emptyState: React.ReactNode;
  minWidth?: React.CSSProperties["minWidth"];
  canManageFolders: boolean;
  canViewItem?: (item: TItem) => boolean;
  canReorganizeItem?: (item: TItem) => boolean;
  getResourceLabel: (item: TItem) => string;
  onItemClick?: (item: TItem) => void;
  onRefresh: (force?: boolean) => Promise<void> | void;
  onCreateFolderRef?: (fn: () => void) => void;
}

function sortResources<TItem extends FolderedResourceListItem>(
  resources: TItem[],
  getResourceLabel: (item: TItem) => string
) {
  return [...resources].sort((a, b) => {
    const aOrder = a.sortOrder ?? 0;
    const bOrder = b.sortOrder ?? 0;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return getResourceLabel(a).localeCompare(getResourceLabel(b));
  });
}

function attachResourcesToFolders<TItem extends FolderedResourceListItem>(
  folders: ResourceFolderTreeNode[],
  resources: TItem[],
  getResourceLabel: (item: TItem) => string
): FolderTreeNodeWithItems<TItem>[] {
  const resourcesByFolder = new Map<string, TItem[]>();
  for (const resource of resources) {
    if (!resource.folderId) continue;
    const current = resourcesByFolder.get(resource.folderId) ?? [];
    current.push(resource);
    resourcesByFolder.set(resource.folderId, current);
  }

  const mapNode = (folder: ResourceFolderTreeNode): FolderTreeNodeWithItems<TItem> => ({
    ...folder,
    items: sortResources(resourcesByFolder.get(folder.id) ?? [], getResourceLabel),
    children: folder.children.map(mapNode),
  });

  return folders.map(mapNode);
}

function buildSystemFolderTree<TItem extends FolderedResourceListItem>(
  folders: FolderedResourceListSystemFolder<TItem>[],
  getResourceLabel: (item: TItem) => string
): FolderTreeNodeWithItems<TItem>[] {
  return folders
    .filter((folder) => folder.items.length > 0)
    .map((folder, index) => ({
      id: folder.id,
      name: folder.name,
      parentId: null,
      sortOrder: index,
      depth: 0,
      createdAt: "",
      updatedAt: "",
      isSystem: true,
      items: sortResources(folder.items, getResourceLabel),
      children: [],
    }));
}

function pruneEmptyFolders<TItem>(
  folders: FolderTreeNodeWithItems<TItem>[]
): FolderTreeNodeWithItems<TItem>[] {
  return folders
    .map((folder) => ({ ...folder, children: pruneEmptyFolders(folder.children) }))
    .filter((folder) => folder.items.length > 0 || folder.children.length > 0);
}

function findResourcesInFolder<TItem>(
  nodes: FolderTreeNodeWithItems<TItem>[],
  folderId: string
): TItem[] {
  for (const node of nodes) {
    if (node.id === folderId) return node.items;
    const found = findResourcesInFolder(node.children, folderId);
    if (found.length > 0) return found;
  }
  return [];
}

export function FolderedResourceList<TItem extends FolderedResourceListItem>({
  resourceType,
  realtimeChannel,
  resources,
  systemFolders = [],
  columns,
  search,
  loading,
  loadingLabel,
  emptyState,
  minWidth = 900,
  canManageFolders,
  canViewItem,
  canReorganizeItem,
  getResourceLabel,
  onItemClick,
  onRefresh,
  onCreateFolderRef,
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
  const folders = foldersByType[resourceType];
  const foldersLoading = loadingByType[resourceType];
  const expandedFolderIds = expandedFolderIdsByType[resourceType];
  const isMobile = useIsMobile();
  const [activeDrag, setActiveDrag] = useState<DragEndEvent["active"] | null>(null);
  const [createFolderParentId, setCreateFolderParentId] = useState<string | null>(null);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [optimisticResources, setOptimisticResources] = useState<TItem[] | null>(null);
  const [collapsedSystemFolderIds, setCollapsedSystemFolderIds] = useState<Set<string>>(
    () => new Set()
  );
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const openCreateFolder = useCallback(() => {
    setCreateFolderParentId(null);
    setCreateFolderOpen(true);
  }, []);

  useEffect(() => {
    onCreateFolderRef?.(openCreateFolder);
  }, [onCreateFolderRef, openCreateFolder]);

  useEffect(() => {
    void fetchFolders(resourceType);
  }, [fetchFolders, resourceType]);

  useRealtime(realtimeChannel, () => {
    void fetchFolders(resourceType);
  });

  const resourceResetKey = resources
    .map((resource) => `${resource.id}:${resource.folderId ?? ""}:${resource.sortOrder ?? 0}`)
    .join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset optimistic overlay when server-provided placement signature changes.
  useEffect(() => {
    setOptimisticResources(null);
  }, [resourceResetKey]);

  const visibleResources = optimisticResources ?? resources;
  const folderIds = useMemo(() => collectFolderTreeIds(folders), [folders]);
  const systemFolderTree = useMemo(
    () => buildSystemFolderTree(systemFolders, getResourceLabel),
    [getResourceLabel, systemFolders]
  );
  const rawFolderTree = useMemo(
    () => attachResourcesToFolders(folders, visibleResources, getResourceLabel),
    [folders, getResourceLabel, visibleResources]
  );
  const folderTree = useMemo(
    () => [
      ...systemFolderTree,
      ...(search.search.trim() ? pruneEmptyFolders(rawFolderTree) : rawFolderTree),
    ],
    [rawFolderTree, search.search, systemFolderTree]
  );
  const ungroupedResources = useMemo(
    () =>
      sortResources(
        visibleResources.filter(
          (resource) => !resource.folderId || !folderIds.has(resource.folderId)
        ),
        getResourceLabel
      ),
    [folderIds, getResourceLabel, visibleResources]
  );

  const isSearchFiltering = search.search.trim() !== "";
  const canDragFolders = canManageFolders && !isMobile && !isSearchFiltering;

  const handleCreateFolder = async (name: string) => {
    try {
      await createFolder(resourceType, name, createFolderParentId ?? undefined);
      toast.success("Folder created");
      setCreateFolderOpen(false);
      setCreateFolderParentId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create folder");
    }
  };

  const handleRenameFolder = async (id: string, name: string) => {
    try {
      await renameFolder(resourceType, id, name);
      toast.success("Folder renamed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename folder");
    }
  };

  const handleDeleteFolder = async (id: string) => {
    const ok = await confirm({
      title: "Delete Folder",
      description:
        "Are you sure? Resources inside will be moved to ungrouped. Subfolders will be deleted.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await deleteFolder(resourceType, id);
      toast.success("Folder deleted");
      await onRefresh(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete folder");
    }
  };

  const applyOptimisticMove = useCallback(
    (resource: TItem, folderId: string | null) => {
      setOptimisticResources((current) => {
        const source = (current ?? resources).map((item) => ({ ...item }));
        const moving = source.find((item) => item.id === resource.id);
        if (!moving) return source;
        const maxSortOrder = source.reduce((max, item) => {
          if ((item.folderId ?? null) !== folderId) return max;
          return Math.max(max, item.sortOrder ?? 0);
        }, -1);
        moving.folderId = folderId;
        moving.sortOrder = maxSortOrder + 1;
        return source;
      });
    },
    [resources]
  );

  const applyOptimisticReorder = useCallback(
    (reordered: TItem[]) => {
      setOptimisticResources((current) => {
        const source = (current ?? resources).map((resource) => ({ ...resource }));
        const orderMap = new Map(reordered.map((resource, index) => [resource.id, index]));
        for (const resource of source) {
          if (orderMap.has(resource.id)) resource.sortOrder = orderMap.get(resource.id);
        }
        return source;
      });
    },
    [resources]
  );

  const moveResource = useCallback(
    async (resource: TItem, folderId: string | null) => {
      applyOptimisticMove(resource, folderId);
      try {
        await moveResourcesToFolder(resourceType, [resource.id], folderId);
        toast.success("Resource moved");
        await onRefresh(true);
      } catch (err) {
        setOptimisticResources(null);
        toast.error(err instanceof Error ? err.message : "Failed to move resource");
      }
    },
    [applyOptimisticMove, moveResourcesToFolder, onRefresh, resourceType]
  );

  const handleToggleFolder = useCallback(
    (folder: FolderTreeNodeWithItems<TItem>) => {
      if (folder.isSystem) {
        setCollapsedSystemFolderIds((current) => {
          const next = new Set(current);
          if (next.has(folder.id)) next.delete(folder.id);
          else next.add(folder.id);
          return next;
        });
        return;
      }
      toggleFolder(resourceType, folder.id);
    },
    [resourceType, toggleFolder]
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDrag(null);
    if (!canManageFolders || isSearchFiltering) return;
    const { active, over } = event;
    if (!over) return;

    const activeData = active.data.current;
    const dropData = over.data.current;

    if (activeData?.type === "folder") {
      if (dropData?.type !== "folder" || active.id === over.id) return;
      const findFolderSiblings = (
        nodes: ResourceFolderTreeNode[],
        folderId: string,
        parentId: string | null = null
      ): { siblings: ResourceFolderTreeNode[]; parentId: string | null } | null => {
        for (const node of nodes) {
          if (node.id === folderId) return { siblings: nodes, parentId };
          const found = findFolderSiblings(node.children, folderId, node.id);
          if (found) return found;
        }
        return null;
      };
      const activeGroup = findFolderSiblings(folders, activeData.folderId as string);
      const overGroup = findFolderSiblings(folders, dropData.folderId as string);
      if (!activeGroup || !overGroup || activeGroup.parentId !== overGroup.parentId) return;
      const oldIndex = activeGroup.siblings.findIndex(
        (folder) => folder.id === activeData.folderId
      );
      const newIndex = overGroup.siblings.findIndex((folder) => folder.id === dropData.folderId);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
      const reordered = [...activeGroup.siblings];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);
      try {
        await reorderFolders(
          resourceType,
          reordered.map((folder, index) => ({ id: folder.id, sortOrder: index }))
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to reorder folders");
      }
      return;
    }

    const source = activeData?.resource as TItem | undefined;
    if (!source || !(canReorganizeItem?.(source) ?? true)) return;

    if (dropData?.type === "folder") {
      const targetFolderId = dropData.folderId as string | null;
      if (dropData.isSystem) return;
      if (source.folderId === targetFolderId) return;
      await moveResource(source, targetFolderId);
      return;
    }

    const overResource = dropData?.resource as TItem | undefined;
    if (!overResource || active.id === over.id) return;
    if (!(canReorganizeItem?.(overResource) ?? true)) return;

    if (source.folderId !== overResource.folderId) {
      await moveResource(source, overResource.folderId ?? null);
      return;
    }

    const resourcesInFolder = source.folderId
      ? findResourcesInFolder(folderTree, source.folderId)
      : ungroupedResources;
    const oldIndex = resourcesInFolder.findIndex((resource) => resource.id === source.id);
    const newIndex = resourcesInFolder.findIndex((resource) => resource.id === overResource.id);
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

    const reordered = [...resourcesInFolder];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);
    applyOptimisticReorder(reordered);

    try {
      await reorderResources(
        resourceType,
        reordered.map((resource, index) => ({ id: resource.id, sortOrder: index }))
      );
      await onRefresh(true);
    } catch (err) {
      setOptimisticResources(null);
      toast.error(err instanceof Error ? err.message : "Failed to reorder resources");
    }
  };

  return (
    <>
      <ResourceListForm<FolderTreeNodeWithItems<TItem>, TItem>
        columns={columns}
        search={search}
        loading={loading || foldersLoading}
        loadingLabel={loadingLabel}
        hasContent={visibleResources.length > 0 || folderTree.length > 0}
        emptyState={emptyState}
        dnd={{
          sensors,
          active: activeDrag,
          onDragStart: (event) => setActiveDrag(event.active),
          onDragEnd: (event) => void handleDragEnd(event),
          onDragCancel: () => setActiveDrag(null),
        }}
        minWidth={minWidth}
        folders={{
          folders: folderTree,
          ungroupedItems: ungroupedResources,
          expandedFolderIds,
          getFolderId: (folder) => folder.id,
          getFolderName: (folder) => folder.name,
          getFolderChildren: (folder) => folder.children,
          getFolderItems: (folder) => folder.items,
          getFolderSortableId: (folder) => `${resourceType}-folder-${folder.id}`,
          getFolderSortableData: (folder) => ({
            type: "folder",
            folderId: folder.id,
            isSystem: folder.isSystem,
            folder,
          }),
          isFolderExpanded: (folder) =>
            folder.isSystem
              ? !collapsedSystemFolderIds.has(folder.id)
              : expandedFolderIds.has(folder.id),
          isFolderSystem: (folder) => !!folder.isSystem,
          isFolderCollapsible: () => true,
          canManageFolder: (folder) => canManageFolders && !folder.isSystem,
          canReorderFolder: (folder) => canDragFolders && !folder.isSystem,
          canCreateSubfolder: (folder) => !folder.isSystem && folder.depth < 2,
          onToggleFolder: (_, folder) => handleToggleFolder(folder),
          onRenameFolder: handleRenameFolder,
          onDeleteFolder: handleDeleteFolder,
          onRequestCreateSubfolder: (parentId) => {
            setCreateFolderParentId(parentId);
            setCreateFolderOpen(true);
          },
          ungroupedDroppable: {
            id: `${resourceType}-folder-ungrouped`,
            data: { type: "folder", folderId: null },
            disabled: !canDragFolders,
          },
        }}
        items={{
          getItemId: (resource) => resource.id,
          getItemSortableId: (resource) => `${resourceType}:${resource.id}`,
          getItemSortableData: (resource) => ({ type: "resource", resource }),
          canViewItem,
          isItemDragDisabled: (resource) =>
            !canDragFolders || !(canReorganizeItem?.(resource) ?? true),
          onItemClick,
        }}
      />

      <FolderCreateDialog
        open={createFolderOpen}
        onOpenChange={setCreateFolderOpen}
        onCreate={handleCreateFolder}
        description={
          createFolderParentId
            ? `Create a subfolder inside "${folders.find((folder) => folder.id === createFolderParentId)?.name ?? "folder"}".`
            : "Enter a name for the new folder."
        }
      />
    </>
  );
}
