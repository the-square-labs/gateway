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
import { Input } from "@/components/ui/input";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";

interface FolderCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  initialName?: string;
  onCreate: (name: string) => void | Promise<void>;
}

export function FolderCreateDialog({
  open,
  onOpenChange,
  title = "Create Folder",
  description = "Enter a name for the new folder.",
  initialName = "",
  onCreate,
}: FolderCreateDialogProps) {
  const [name, setName] = useState(initialName);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const displayedTitle = useRetainedDialogValue(title, open);
  const displayedDescription = useRetainedDialogValue(description, open);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setIsSubmitting(false);
    }
  }, [open, initialName]);

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setIsSubmitting(true);
    try {
      await onCreate(trimmed);
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{displayedTitle}</DialogTitle>
          <DialogDescription>{displayedDescription}</DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder="Folder name"
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={isSubmitting || !name.trim()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
