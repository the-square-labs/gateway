import type { Active, DndContextProps } from "@dnd-kit/core";
import type * as React from "react";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";

export type ResourceListDndHandlers = Pick<
  DndContextProps,
  "sensors" | "collisionDetection" | "onDragStart" | "onDragEnd" | "onDragCancel"
> & {
  active: Active | null;
};

export interface ResourceListSearchProps {
  placeholder?: string;
  search: string;
  onSearchChange: (value: string) => void;
  onSearchSubmit?: () => void;
  hasActiveFilters: boolean;
  onReset: () => void;
  filters?: React.ReactNode;
}

export interface ResourceListFolderConfig<TFolder, TItem> {
  folders: TFolder[];
  ungroupedItems: TItem[];
  expandedFolderIds: Set<string>;
  getFolderId: (folder: TFolder) => string;
  getFolderName: (folder: TFolder) => string;
  getFolderChildren: (folder: TFolder) => TFolder[];
  getFolderItems: (folder: TFolder) => TItem[];
  getFolderDepth?: (folder: TFolder) => number;
  getFolderSortableId: (folder: TFolder) => string;
  getFolderSortableData: (folder: TFolder) => Record<string, unknown>;
  isFolderExpanded?: (folder: TFolder) => boolean;
  isFolderSystem?: (folder: TFolder) => boolean;
  isFolderCollapsible?: (folder: TFolder) => boolean;
  canManageFolder?: (folder: TFolder) => boolean;
  canReorderFolder?: (folder: TFolder) => boolean;
  canCreateSubfolder?: (folder: TFolder) => boolean;
  renderFolderBadges?: (folder: TFolder) => React.ReactNode;
  onToggleFolder: (id: string, folder: TFolder) => void;
  onRenameFolder?: (id: string, name: string) => void;
  onDeleteFolder?: (id: string) => void;
  onRequestCreateSubfolder?: (id: string) => void;
  ungroupedLabel?: React.ReactNode;
  ungroupedDroppable?: {
    id: string;
    data: Record<string, unknown>;
    disabled?: boolean;
  };
}

export interface ResourceListItemConfig<TItem> {
  getItemId: (item: TItem) => string;
  getItemSortableId: (item: TItem) => string;
  getItemSortableData: (item: TItem) => Record<string, unknown>;
  canViewItem?: (item: TItem) => boolean;
  isItemDragDisabled?: (item: TItem) => boolean;
  onItemClick?: (item: TItem) => void;
}

export interface ResourceListFormProps<TFolder, TItem> {
  columns: ResourceListColumn<TItem>[];
  search: ResourceListSearchProps;
  folders: ResourceListFolderConfig<TFolder, TItem>;
  items: ResourceListItemConfig<TItem>;
  dnd?: ResourceListDndHandlers;
  minWidth?: React.CSSProperties["minWidth"];
  loading?: boolean;
  loadingLabel?: string;
  hasContent: boolean;
  emptyState: React.ReactNode;
  afterSearch?: React.ReactNode;
}
