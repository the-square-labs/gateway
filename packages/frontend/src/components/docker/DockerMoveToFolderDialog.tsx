import { ChevronRight, Folder, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { cn } from "@/lib/utils";
import type { DockerFolderTreeNode } from "@/types";

interface DockerMoveToFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folders: DockerFolderTreeNode[];
  currentFolderId: string | null;
  onMove: (folderId: string | null) => void;
}

function FolderOption({
  folder,
  depth,
  selected,
  onSelect,
}: {
  folder: DockerFolderTreeNode;
  depth: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <>
      <button
        type="button"
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors",
          folder.isSystem ? "opacity-50 cursor-not-allowed" : "hover:bg-accent",
          selected === folder.id && "bg-accent"
        )}
        style={{ paddingLeft: `${depth * 20 + 12}px` }}
        onClick={() => {
          if (!folder.isSystem) onSelect(folder.id);
        }}
      >
        {folder.children.length > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
        <Folder className="h-4 w-4 text-muted-foreground" />
        {folder.isSystem && <Lock className="h-3 w-3 text-muted-foreground" />}
        <span>{folder.name}</span>
      </button>
      {folder.children.map((child) => (
        <FolderOption
          key={child.id}
          folder={child}
          depth={depth + 1}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

export function DockerMoveToFolderDialog({
  open,
  onOpenChange,
  folders,
  currentFolderId,
  onMove,
}: DockerMoveToFolderDialogProps) {
  const [selected, setSelected] = useState<string | null>(currentFolderId);
  const displayedCurrentFolderId = useRetainedDialogValue(currentFolderId, open);

  useEffect(() => {
    if (open) setSelected(currentFolderId);
  }, [open, currentFolderId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move to Folder</DialogTitle>
          <DialogDescription>
            Select a destination folder or move to root (ungrouped).
          </DialogDescription>
        </DialogHeader>
        <div className="border border-border">
          <button
            type="button"
            className={cn(
              "w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-accent transition-colors",
              selected === null && "bg-accent"
            )}
            onClick={() => setSelected(null)}
          >
            <span className="font-medium">Root (ungrouped)</span>
          </button>
          {folders.map((folder) => (
            <FolderOption
              key={folder.id}
              folder={folder}
              depth={0}
              selected={selected}
              onSelect={setSelected}
            />
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onMove(selected);
              onOpenChange(false);
            }}
            disabled={selected === displayedCurrentFolderId}
          >
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
