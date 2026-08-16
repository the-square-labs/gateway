import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { motion } from "framer-motion";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Lock,
  MoreVertical,
  Pencil,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { InlineFolderEditor } from "@/components/common/InlineFolderEditor";
import { type ResourceListColumn, ResourceListTable } from "@/components/common/ResourceListLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ResourceListItemRow } from "./ResourceListItemRow";
import type { ResourceListFolderConfig, ResourceListItemConfig } from "./types";
import { countFolderItems } from "./utils";

interface ResourceFolderGroupProps<TFolder, TItem> {
  folder: TFolder;
  depth: number;
  columns: ResourceListColumn<TItem>[];
  folderConfig: ResourceListFolderConfig<TFolder, TItem>;
  itemConfig: ResourceListItemConfig<TItem>;
}

export function ResourceFolderGroup<TFolder, TItem>({
  folder,
  depth,
  columns,
  folderConfig,
  itemConfig,
}: ResourceFolderGroupProps<TFolder, TItem>) {
  const [isRenaming, setIsRenaming] = useState(false);
  const folderId = folderConfig.getFolderId(folder);
  const children = folderConfig.getFolderChildren(folder);
  const items = folderConfig.getFolderItems(folder);
  const collapsible = folderConfig.isFolderCollapsible?.(folder) ?? true;
  const expanded = collapsible
    ? (folderConfig.isFolderExpanded?.(folder) ?? folderConfig.expandedFolderIds.has(folderId))
    : true;
  const canManage = folderConfig.canManageFolder?.(folder) ?? false;
  const canReorder = folderConfig.canReorderFolder?.(folder) ?? false;
  const isSystem = folderConfig.isFolderSystem?.(folder) ?? false;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: folderConfig.getFolderSortableId(folder),
    data: { folder, ...folderConfig.getFolderSortableData(folder) },
    disabled: !canReorder,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : "none",
    opacity: isDragging ? 0.3 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <div
        className={cn(
          "flex min-h-[53px] items-center gap-2 border-b border-border px-3 py-2 transition-colors",
          collapsible && "cursor-pointer hover:bg-accent"
        )}
        style={{ paddingLeft: `${depth * 24 + 12}px` }}
        onClick={collapsible ? () => folderConfig.onToggleFolder(folderId, folder) : undefined}
        {...(canReorder ? attributes : {})}
        {...(canReorder ? listeners : {})}
      >
        {collapsible ? (
          <button type="button" className="shrink-0 text-muted-foreground">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground opacity-40" />
        )}
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        {isSystem && <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}

        {isRenaming ? (
          <div onClick={(e) => e.stopPropagation()}>
            <InlineFolderEditor
              initialName={folderConfig.getFolderName(folder)}
              onSave={(name) => {
                folderConfig.onRenameFolder?.(folderId, name);
                setIsRenaming(false);
              }}
              onCancel={() => setIsRenaming(false)}
            />
          </div>
        ) : (
          <span className="min-w-0 truncate text-sm font-medium">
            {folderConfig.getFolderName(folder)}
          </span>
        )}

        <Badge variant="secondary" size="inline" className="ml-1">
          {countFolderItems(folder, folderConfig)}
        </Badge>
        {folderConfig.renderFolderBadges?.(folder)}

        {canManage && !isRenaming && (
          <div className="ml-auto" onClick={(e) => e.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setIsRenaming(true)}>
                  <Pencil className="h-4 w-4" />
                  Rename
                </DropdownMenuItem>
                {folderConfig.canCreateSubfolder?.(folder) && (
                  <DropdownMenuItem
                    onClick={() => folderConfig.onRequestCreateSubfolder?.(folderId)}
                  >
                    <FolderPlus className="h-4 w-4" />
                    Add subfolder
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => folderConfig.onDeleteFolder?.(folderId)}
                  className="text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <motion.div
        initial={false}
        animate={{ height: expanded ? "auto" : 0, opacity: expanded ? 1 : 0 }}
        transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
        className="overflow-hidden"
        aria-hidden={!expanded}
      >
        {children.length > 0 && (
          <SortableContext
            items={children.map(folderConfig.getFolderSortableId)}
            strategy={verticalListSortingStrategy}
          >
            {children.map((child) => (
              <ResourceFolderGroup
                key={folderConfig.getFolderId(child)}
                folder={child}
                depth={depth + 1}
                columns={columns}
                folderConfig={folderConfig}
                itemConfig={itemConfig}
              />
            ))}
          </SortableContext>
        )}
        {items.length > 0 && (
          <SortableContext
            items={items.map(itemConfig.getItemSortableId)}
            strategy={verticalListSortingStrategy}
          >
            <ResourceListTable columns={columns}>
              {items.map((item) => (
                <ResourceListItemRow
                  key={itemConfig.getItemId(item)}
                  item={item}
                  depth={depth + 1}
                  columns={columns}
                  config={itemConfig}
                />
              ))}
            </ResourceListTable>
          </SortableContext>
        )}
      </motion.div>
    </div>
  );
}
