import { DndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  ResourceListCell,
  ResourceListFrame,
  ResourceListHeaderTable,
  ResourceListRow,
  ResourceListTable,
} from "@/components/common/ResourceListLayout";
import { ResourceDragOverlay } from "@/components/common/resource-list/ResourceDragOverlay";
import { ResourceFolderGroup } from "@/components/common/resource-list/ResourceFolderGroup";
import { ResourceUngroupedSection } from "@/components/common/resource-list/ResourceUngroupedSection";
import type { ResourceListFormProps } from "@/components/common/resource-list/types";
import { SearchFilterBar } from "@/components/common/SearchFilterBar";
import { Skeleton } from "@/components/ui/skeleton";
import { pointerFirstCollisionDetection } from "@/lib/dnd-collision";

export function ResourceListForm<TFolder, TItem>({
  columns,
  search,
  folders,
  items,
  dnd,
  minWidth = 900,
  loading,
  loadingLabel = "Loading...",
  hasContent,
  emptyState,
  afterSearch,
}: ResourceListFormProps<TFolder, TItem>) {
  const topLevelFolders = folders.folders;
  const ungroupedItems = folders.ungroupedItems;
  const showLoading = loading && !hasContent;
  const frame = (
    <ResourceListFrame minWidth={minWidth}>
      <ResourceListHeaderTable columns={columns} />
      {topLevelFolders.length > 0 && (
        <SortableContext
          items={topLevelFolders.map(folders.getFolderSortableId)}
          strategy={verticalListSortingStrategy}
        >
          {topLevelFolders.map((folder) => (
            <ResourceFolderGroup
              key={folders.getFolderId(folder)}
              folder={folder}
              depth={folders.getFolderDepth?.(folder) ?? 0}
              columns={columns}
              folderConfig={folders}
              itemConfig={items}
            />
          ))}
        </SortableContext>
      )}
      {(topLevelFolders.length > 0 || ungroupedItems.length > 0) && (
        <ResourceUngroupedSection
          columns={columns}
          items={ungroupedItems}
          itemConfig={items}
          folderConfig={folders}
          showHeader={topLevelFolders.length > 0}
        />
      )}
    </ResourceListFrame>
  );
  const loadingFrame = (
    <div aria-label={loadingLabel} aria-busy="true">
      <ResourceListFrame minWidth={minWidth}>
        <ResourceListHeaderTable columns={columns} />
        <ResourceListTable columns={columns}>
          {Array.from({ length: 5 }, (_, row) => (
            <ResourceListRow key={row} aria-hidden="true">
              {columns.map((column, columnIndex) => (
                <ResourceListCell key={column.id} align={column.align}>
                  <Skeleton className={columnIndex === 0 ? "h-5 w-2/3" : "h-4 w-1/2"} />
                </ResourceListCell>
              ))}
            </ResourceListRow>
          ))}
        </ResourceListTable>
      </ResourceListFrame>
    </div>
  );

  return (
    <div className="space-y-3">
      <SearchFilterBar {...search} />
      {afterSearch}
      {showLoading ? (
        loadingFrame
      ) : hasContent ? (
        <DndContext
          sensors={dnd?.sensors}
          collisionDetection={dnd?.collisionDetection ?? pointerFirstCollisionDetection}
          onDragStart={dnd?.onDragStart}
          onDragEnd={dnd?.onDragEnd}
          onDragCancel={dnd?.onDragCancel}
        >
          {frame}
          {dnd && (
            <ResourceDragOverlay
              active={dnd.active}
              columns={columns}
              folderConfig={folders}
              itemConfig={items}
            />
          )}
        </DndContext>
      ) : (
        emptyState
      )}
    </div>
  );
}
