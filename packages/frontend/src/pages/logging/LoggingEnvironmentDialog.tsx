import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { handleLicenseApiError } from "@/stores/license-paywall";
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
    } catch (error) {
      if (!handleLicenseApiError(error, "Logging environments")) {
        toast.error(
          error instanceof Error ? error.message : "Failed to create logging environment"
        );
      }
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
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Production"
            />
          </label>
          {environment && (
            <p className="text-xs text-muted-foreground">
              Slug: <span className="font-mono">{environment.slug}</span>
            </p>
          )}
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Description</span>
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Application logs from production services"
            />
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
