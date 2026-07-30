import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { LoggingEnvironment } from "@/types";

export function LoggingEnvironmentDialog({
  open,
  environment,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  environment?: LoggingEnvironment | null;
  onOpenChange: (open: boolean) => void;
  onSave: (data: Partial<LoggingEnvironment>) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(environment?.name ?? "");
    setDescription(environment?.description ?? "");
  }, [environment, open]);

  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        name,
        description: description || null,
        schemaMode: environment?.schemaMode ?? "loose",
        retentionDays: environment?.retentionDays ?? 30,
        fieldSchema: environment?.fieldSchema ?? [],
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{environment ? "Edit Environment" : "Create Environment"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Name</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          {environment && (
            <p className="text-xs text-muted-foreground">
              Slug: <span className="font-mono">{environment.slug}</span>
            </p>
          )}
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Description</span>
            <Input value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || saving} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
