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
import { collectFolderTreeIds, findFolderTreeNode } from "@/lib/folder-tree";
import { useDockerFolderStore } from "@/stores/docker-folders";
import type { DockerFolderResourceType, DockerFolderTreeNode } from "@/types";

export interface DockerFolderedResourceItem {
  folderId?: string | null;
  folderIsSystem?: boolean;
  folderSortOrder?: number;
  _nodeId?: string;
}

interface DockerFolderTreeNodeWithItems<TItem> extends DockerFolderTreeNode {
  items: TItem[];
  children: DockerFolderTreeNodeWithItems<TItem>[];
}

interface DockerFolderedResourceListProps<TItem extends DockerFolderedResourceItem> {
  resourceType: Exclude<DockerFolderResourceType, "container">;
  resources: TItem[];
  columns: ResourceListColumn<TItem>[];
  search: {
    search: string;
    onSearchChange: (value: string) => void;
    placeholder: string;
    hasActiveFilters: boolean;
    onReset: () => void;
    filters?: React.ReactNode;
  };
  loading: boolean;
  loadingLabel: string;
  emptyState: React.ReactNode;
  afterSearch?: React.ReactNode;
  minWidth?: React.CSSProperties["minWidth"];
  fixedNodeId?: string;
  canManageFolders: boolean;
  canViewItem?: (item: TItem) => boolean;
  canReorganizeItem?: (item: TItem) => boolean;
  getResourceKey: (item: TItem) => string;
  getResourceLabel: (item: TItem) => string;
  onItemClick?: (item: TItem) => void;
  onRefresh: (force?: boolean) => Promise<void> | void;
  onCreateFolderRef?: (fn: () => void) => void;
}

function sortResources<TItem extends DockerFolderedResourceItem>(
  resources: TItem[],
  getResourceLabel: (item: TItem) => string
) {
  return [...resources].sort((a, b) => {
    const aOrder = a.folderSortOrder ?? 0;
    const bOrder = b.folderSortOrder ?? 0;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return getResourceLabel(a).localeCompare(getResourceLabel(b));
  });
}

function attachResourcesToFolders<TItem extends DockerFolderedResourceItem>(
  folders: DockerFolderTreeNode[],
  resources: TItem[],
  getResourceLabel: (item: TItem) => string
): DockerFolderTreeNodeWithItems<TItem>[] {
  const resourcesByFolder = new Map<string, TItem[]>();
  for (const resource of resources) {
    if (!resource.folderId) continue;
    const current = resourcesByFolder.get(resource.folderId) ?? [];
    current.push(resource);
    resourcesByFolder.set(resource.folderId, current);
  }

  const mapNode = (folder: DockerFolderTreeNode): DockerFolderTreeNodeWithItems<TItem> => ({
    ...folder,
    items: sortResources(resourcesByFolder.get(folder.id) ?? [], getResourceLabel),
    children: folder.children.map(mapNode),
  });

  return folders.map(mapNode);
}

function pruneEmptyFolders<TItem>(
  folders: DockerFolderTreeNodeWithItems<TItem>[]
): DockerFolderTreeNodeWithItems<TItem>[] {
  return folders
    .map((folder) => ({ ...folder, children: pruneEmptyFolders(folder.children) }))
    .filter((folder) => folder.items.length > 0 || folder.children.length > 0);
}

function findResourcesInFolder<TItem>(
  nodes: DockerFolderTreeNodeWithItems<TItem>[],
  folderId: string
): TItem[] {
  for (const node of nodes) {
    if (node.id === folderId) return node.items;
    const found = findResourcesInFolder(node.children, folderId);
    if (found.length > 0) return found;
  }
  return [];
}

export function DockerFolderedResourceList<TItem extends DockerFolderedResourceItem>({
  resourceType,
  resources,
  columns,
  search,
  loading,
  loadingLabel,
  emptyState,
  afterSearch,
  minWidth = 900,
  fixedNodeId,
  canManageFolders,
  canViewItem,
  canReorganizeItem,
  getResourceKey,
  getResourceLabel,
  onItemClick,
  onRefresh,
  onCreateFolderRef,
}: DockerFolderedResourceListProps<TItem>) {
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
  } = useDockerFolderStore();
  const folders = foldersByType[resourceType];
  const foldersLoading = loadingByType[resourceType];
  const expandedFolderIds = expandedFolderIdsByType[resourceType];
  const isMobile = useIsMobile();
  const [activeDrag, setActiveDrag] = useState<DragEndEvent["active"] | null>(null);
  const [createFolderParentId, setCreateFolderParentId] = useState<string | null>(null);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [optimisticResources, setOptimisticResources] = useState<TItem[] | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

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

  useRealtime("docker.folder.changed", () => {
    void fetchFolders(resourceType);
  });

  const resourceResetKey = resources
    .map(
      (resource) =>
        `${resource._nodeId ?? "node"}:${getResourceKey(resource)}:${resource.folderId ?? ""}:${
          resource.folderSortOrder ?? 0
        }`
    )
    .join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset optimistic overlay when server-provided placement signature changes.
  useEffect(() => {
    setOptimisticResources(null);
  }, [resourceResetKey]);

  const visibleResources = optimisticResources ?? resources;
  const folderIds = useMemo(() => collectFolderTreeIds(folders), [folders]);
  const rawFolderTree = useMemo(
    () => attachResourcesToFolders(folders, visibleResources, getResourceLabel),
    [folders, getResourceLabel, visibleResources]
  );
  const folderTree = useMemo(
    () => (fixedNodeId || search.search.trim() ? pruneEmptyFolders(rawFolderTree) : rawFolderTree),
    [fixedNodeId, rawFolderTree, search.search]
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
      await createFolder(name, createFolderParentId ?? undefined, resourceType);
      toast.success("Folder created");
      setCreateFolderOpen(false);
      setCreateFolderParentId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create folder");
    }
  };

  const handleRenameFolder = async (id: string, name: string) => {
    try {
      await renameFolder(id, name, resourceType);
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
      await deleteFolder(id, resourceType);
      toast.success("Folder deleted");
      await onRefresh(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete folder");
    }
  };

  const applyOptimisticMove = useCallback(
    (resource: TItem, folderId: string | null) => {
      const targetFolder = folderId ? findFolderTreeNode(folders, folderId) : null;
      setOptimisticResources((current) => {
        const source = (current ?? resources).map((item) => ({ ...item }));
        const moving = source.find(
          (item) =>
            item._nodeId === resource._nodeId && getResourceKey(item) === getResourceKey(resource)
        );
        if (!moving) return source;

        const maxSortOrder = source.reduce((max, item) => {
          if ((item.folderId ?? null) !== folderId) return max;
          return Math.max(max, item.folderSortOrder ?? 0);
        }, -1);

        moving.folderId = folderId;
        moving.folderIsSystem = targetFolder?.isSystem ?? false;
        moving.folderSortOrder = maxSortOrder + 1;
        return source;
      });
    },
    [folders, getResourceKey, resources]
  );

  const applyOptimisticReorder = useCallback(
    (reordered: TItem[]) => {
      setOptimisticResources((current) => {
        const source = (current ?? resources).map((resource) => ({ ...resource }));
        const orderMap = new Map<string, number>(
          reordered.map((resource, index) => [
            `${resource._nodeId}:${getResourceKey(resource)}`,
            index,
          ])
        );
        for (const resource of source) {
          const key = `${resource._nodeId}:${getResourceKey(resource)}`;
          if (orderMap.has(key)) resource.folderSortOrder = orderMap.get(key);
        }
        return source;
      });
    },
    [getResourceKey, resources]
  );

  const moveResource = useCallback(
    async (resource: TItem, folderId: string | null) => {
      const nodeId = resource._nodeId;
      if (!nodeId) return;
      applyOptimisticMove(resource, folderId);
      try {
        await moveResourcesToFolder(
          resourceType,
          [{ nodeId, resourceKey: getResourceKey(resource) }],
          folderId
        );
        toast.success("Resource moved");
        await onRefresh(true);
      } catch (err) {
        setOptimisticResources(null);
        toast.error(err instanceof Error ? err.message : "Failed to move resource");
      }
    },
    [applyOptimisticMove, getResourceKey, moveResourcesToFolder, onRefresh, resourceType]
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
        nodes: DockerFolderTreeNode[],
        folderId: string,
        parentId: string | null = null
      ): { siblings: DockerFolderTreeNode[]; parentId: string | null } | null => {
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
          reordered.map((folder, index) => ({ id: folder.id, sortOrder: index })),
          resourceType
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to reorder folders");
      }
      return;
    }

    const source = activeData?.resource as TItem | undefined;
    if (!source || source.folderIsSystem) return;

    if (dropData?.type === "folder") {
      const targetFolderId = dropData.folderId as string | null;
      if (dropData.isSystem || source.folderId === targetFolderId) return;
      await moveResource(source, targetFolderId);
      return;
    }

    const overResource = dropData?.resource as TItem | undefined;
    if (!overResource || active.id === over.id || overResource.folderIsSystem) return;

    if (source.folderId !== overResource.folderId) {
      await moveResource(source, overResource.folderId ?? null);
      return;
    }

    const resourcesInFolder = source.folderId
      ? findResourcesInFolder(folderTree, source.folderId)
      : ungroupedResources;
    const oldIndex = resourcesInFolder.findIndex(
      (resource) =>
        resource._nodeId === source._nodeId && getResourceKey(resource) === getResourceKey(source)
    );
    const newIndex = resourcesInFolder.findIndex(
      (resource) =>
        resource._nodeId === overResource._nodeId &&
        getResourceKey(resource) === getResourceKey(overResource)
    );
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

    const reordered = [...resourcesInFolder];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);
    applyOptimisticReorder(reordered);

    try {
      await reorderResources(
        resourceType,
        reordered
          .filter((resource) => resource._nodeId)
          .map((resource, index) => ({
            nodeId: resource._nodeId!,
            resourceKey: getResourceKey(resource),
            sortOrder: index,
          }))
      );
      await onRefresh(true);
    } catch (err) {
      setOptimisticResources(null);
      toast.error(err instanceof Error ? err.message : "Failed to reorder resources");
    }
  };

  return (
    <>
      <ResourceListForm<DockerFolderTreeNodeWithItems<TItem>, TItem>
        columns={columns}
        search={search}
        afterSearch={afterSearch}
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
          getFolderSortableId: (folder) => `docker-${resourceType}-folder-${folder.id}`,
          getFolderSortableData: (folder) => ({
            type: "folder",
            folderId: folder.id,
            isSystem: folder.isSystem,
            folder,
          }),
          isFolderExpanded: (folder) => (fixedNodeId ? true : expandedFolderIds.has(folder.id)),
          isFolderSystem: (folder) => folder.isSystem,
          isFolderCollapsible: () => !fixedNodeId,
          canManageFolder: (folder) => canManageFolders && !folder.isSystem,
          canReorderFolder: (folder) => canDragFolders && !folder.isSystem,
          canCreateSubfolder: (folder) => folder.depth < 2,
          onToggleFolder: fixedNodeId ? () => {} : (id) => toggleFolder(id, resourceType),
          onRenameFolder: handleRenameFolder,
          onDeleteFolder: handleDeleteFolder,
          onRequestCreateSubfolder: (parentId) => {
            setCreateFolderParentId(parentId);
            setCreateFolderOpen(true);
          },
          ungroupedDroppable: {
            id: `docker-${resourceType}-folder-ungrouped`,
            data: { type: "folder", folderId: null, isSystem: false },
            disabled: !canDragFolders,
          },
        }}
        items={{
          getItemId: (resource) => `${resource._nodeId ?? "node"}:${getResourceKey(resource)}`,
          getItemSortableId: (resource) =>
            `${resource._nodeId ?? "node"}:${getResourceKey(resource)}`,
          getItemSortableData: (resource) => ({ type: "resource", resource }),
          canViewItem,
          isItemDragDisabled: (resource) =>
            !canDragFolders ||
            !!resource.folderIsSystem ||
            !(canReorganizeItem?.(resource) ?? true),
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
