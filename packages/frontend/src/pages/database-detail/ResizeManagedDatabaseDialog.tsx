import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { api } from "@/services/api";
import type { DatabaseConnection } from "@/types";
import { type ManagedDatabaseCapacity, managedDatabaseCapacity } from "./managed-database-capacity";

export function ResizeManagedDatabaseDialog({
  database,
  open,
  onOpenChange,
  onResized,
}: {
  database: DatabaseConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResized: () => void;
}) {
  const managed = database.managed!;
  const currentStorageSizeGb = Math.max(1, Math.round(managed.storageSizeBytes / 1024 ** 3));
  const [storageSizeGb, setStorageSizeGb] = useState(String(currentStorageSizeGb + 1));
  const [capacity, setCapacity] = useState<ManagedDatabaseCapacity | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setStorageSizeGb(String(currentStorageSizeGb + 1));
    setCapacity(null);
    api
      .getNode(managed.nodeId)
      .then((node) => {
        if (!cancelled) setCapacity(managedDatabaseCapacity(node));
      })
      .catch(() => {
        if (!cancelled) setCapacity(null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentStorageSizeGb, managed.nodeId, open]);

  const nextStorageSizeGb = Number(storageSizeGb);
  const maximumStorageSizeGb =
    capacity?.storageSizeGb === undefined
      ? undefined
      : currentStorageSizeGb + capacity.storageSizeGb;
  const isValidSize =
    Number.isInteger(nextStorageSizeGb) &&
    nextStorageSizeGb > currentStorageSizeGb &&
    (maximumStorageSizeGb === undefined || nextStorageSizeGb <= maximumStorageSizeGb);

  const resize = async () => {
    if (!isValidSize) return;
    setSaving(true);
    try {
      await api.updateManagedDatabase(managed.id, { storageSizeGb: nextStorageSizeGb });
      toast.success("Database storage resized");
      onOpenChange(false);
      onResized();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to resize database storage");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Resize database</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <DialogDescription>
            Database storage can only be increased. This change expands the managed storage image
            without recreating the database.
          </DialogDescription>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="managed-database-resize-storage">
              New storage size, GB
            </label>
            <Input
              id="managed-database-resize-storage"
              type="number"
              min={currentStorageSizeGb + 1}
              max={maximumStorageSizeGb}
              value={storageSizeGb}
              onChange={(event) => setStorageSizeGb(event.target.value)}
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">
              {maximumStorageSizeGb === undefined
                ? `Enter a whole number greater than ${currentStorageSizeGb} GB.`
                : `Maximum available now: ${maximumStorageSizeGb} GB.`}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void resize()} disabled={saving || !isValidSize}>
            {saving ? "Resizing..." : "Resize database"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
