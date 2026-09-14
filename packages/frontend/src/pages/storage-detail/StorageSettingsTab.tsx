import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { api } from "@/services/api";
import type { ObjectStorageConnection } from "@/types";
import {
  buildStoragePayload,
  draftFromConnection,
  type StorageConnectionDraft,
  StorageConnectionForm,
} from "./StorageConnectionForm";

export function StorageSettingsTab({
  storage,
  onSaved,
}: {
  storage: ObjectStorageConnection;
  onSaved: (storage: ObjectStorageConnection) => void;
}) {
  const [draft, setDraft] = useState<StorageConnectionDraft>(draftFromConnection(storage));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(draftFromConnection(storage));
  }, [storage]);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.updateObjectStorage(storage.id, buildStoragePayload(draft));
      toast.success("Storage settings updated");
      onSaved(updated);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update storage");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <StorageConnectionForm draft={draft} onChange={setDraft} storageId={storage.id} />
      <DialogFooter>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </DialogFooter>
    </div>
  );
}
