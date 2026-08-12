import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { api } from "@/services/api";
import type { DatabaseConnection } from "@/types";
import {
  buildDatabasePayload,
  type DatabaseConnectionDraft,
  DatabaseConnectionForm,
  draftFromConnection,
} from "./DatabaseConnectionForm";

export function DatabaseSettingsTab({
  database,
  onSaved,
}: {
  database: DatabaseConnection;
  onSaved: (database: DatabaseConnection) => void;
}) {
  const [draft, setDraft] = useState<DatabaseConnectionDraft>(draftFromConnection(database));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(draftFromConnection(database));
  }, [database]);

  const save = async () => {
    const queryBudget = Number(draft.interactiveQueryBudgetSeconds);
    if (
      database.type !== "redis" &&
      (!Number.isInteger(queryBudget) || queryBudget < 30 || queryBudget > 600)
    ) {
      toast.error("Interactive query budget must be between 30 and 600 seconds");
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateDatabase(database.id, buildDatabasePayload(draft));
      toast.success("Database settings updated");
      onSaved(updated);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update database");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <DatabaseConnectionForm draft={draft} onChange={setDraft} disableType mode="metadata" />
      <DialogFooter>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </DialogFooter>
    </div>
  );
}
