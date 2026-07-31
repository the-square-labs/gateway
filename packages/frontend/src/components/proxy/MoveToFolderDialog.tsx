import { ChevronRight, Folder } from "lucide-react";
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
import type { FolderTreeNode } from "@/types";

interface MoveToFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folders: FolderTreeNode[];
  currentFolderId: string | null;
  onMove: (folderId: string | null) => void;
}

function FolderOption({
  folder,
  depth,
  selected,
  onSelect,
}: {
  folder: FolderTreeNode;
  depth: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <>
      <button
        type="button"
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-accent transition-colors",
          selected === folder.id && "bg-accent"
        )}
        style={{ paddingLeft: `${depth * 20 + 12}px` }}
        onClick={() => onSelect(folder.id)}
      >
        {folder.children.length > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
        <Folder className="h-4 w-4 text-muted-foreground" />
        <span>{folder.name}</span>
        <span className="text-xs text-muted-foreground ml-auto">{folder.hosts.length} hosts</span>
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

export function MoveToFolderDialog({
  open,
  onOpenChange,
  folders,
  currentFolderId,
  onMove,
}: MoveToFolderDialogProps) {
  const [selected, setSelected] = useState<string | null>(currentFolderId);
  const displayedCurrentFolderId = useRetainedDialogValue(currentFolderId, open);

  useEffect(() => {
    if (open) setSelected(currentFolderId);
  }, [open, currentFolderId]);

  const handleMove = () => {
    onMove(selected);
    onOpenChange(false);
  };

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
          <Button onClick={handleMove} disabled={selected === displayedCurrentFolderId}>
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
