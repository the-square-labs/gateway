import { Loader2, Pause, Play, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow, SettingsInlineControl } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/services/api";
import type { BackupPolicy, BackupPolicyInput, BackupRun } from "@/types/backups";
import type { DatabaseConnection } from "@/types/databases";

const backupApi = api;
const defaultLimits = {
  workspaceBytes: 20 * 1024 ** 3,
  timeoutSeconds: 3600,
  cpuCores: 1,
  memoryMb: 1024,
};

export interface BackupSelectionOption {
  id: string;
  label: string;
  disabledReason?: string;
  provider?: string;
}

export function DatabaseBackupsTab({
  database,
  destinations,
  executors,
  canManage,
  canRun,
  canRestore,
}: {
  database: DatabaseConnection;
  destinations: BackupSelectionOption[];
  executors: BackupSelectionOption[];
  canManage: boolean;
  canRun: boolean;
  canRestore: boolean;
}) {
  const [policies, setPolicies] = useState<BackupPolicy[]>([]);
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [restoreRun, setRestoreRun] = useState<BackupRun | null>(null);
  const refresh = useCallback(
    async (background = false) => {
      if (!background) setLoading(true);
      try {
        const [nextPolicies, nextRuns] = await Promise.all([
          backupApi.listBackupPolicies(database.id),
          backupApi.listBackupRuns(database.id),
        ]);
        setPolicies(nextPolicies);
        setRuns(nextRuns);
      } catch {
        toast.error("Could not load backup history");
      } finally {
        setLoading(false);
      }
    },
    [database.id]
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) return;
    const timer = window.setInterval(() => void refresh(true), 5000);
    return () => window.clearInterval(timer);
  }, [runs, refresh]);
  const deleteHistory = useCallback(
    async (run: BackupRun) => {
      try {
        await backupApi.deleteBackupHistory(database.id, run.id);
        toast.success("History removed");
        await refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not remove history");
      }
    },
    [database.id, refresh]
  );
  const cancel = useCallback(
    async (run: BackupRun) => {
      try {
        await backupApi.cancelBackup(database.id, run.id);
        toast.message("Cancellation requested");
        await refresh();
      } catch {
        toast.error("Could not request cancellation");
      }
    },
    [database.id, refresh]
  );
  const columns = useMemo<DataTableColumn<BackupRun>[]>(
    () => [
      {
        key: "created",
        header: "Started",
        render: (run) => new Date(run.createdAt).toLocaleString(),
      },
      {
        key: "type",
        header: "Operation",
        render: (run) => <span className="capitalize">{run.direction}</span>,
      },
      {
        key: "status",
        header: "Status",
        render: (run) => (
          <Badge
            variant={
              run.status === "completed"
                ? "secondary"
                : run.status === "failed"
                  ? "destructive"
                  : "outline"
            }
          >
            {run.phase === "queued" ? "Queued" : run.status}
          </Badge>
        ),
      },
      {
        key: "size",
        header: "Size",
        align: "right",
        render: (run) =>
          run.bytes === "0" ? "—" : `${(Number(run.bytes) / 1024 ** 2).toFixed(1)} MB`,
      },
      {
        key: "actions",
        header: "",
        align: "right",
        render: (run) => (
          <div className="flex justify-end gap-2">
            {run.direction === "backup" &&
            run.status === "completed" &&
            !run.artifactsDeletedAt &&
            canRestore ? (
              <Button size="sm" variant="outline" onClick={() => setRestoreRun(run)}>
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                Restore
              </Button>
            ) : null}
            {canManage &&
            !["queued", "running"].includes(run.status) &&
            (!run.manifest || run.artifactsDeletedAt) ? (
              <Button size="sm" variant="ghost" onClick={() => void deleteHistory(run)}>
                Remove history
              </Button>
            ) : null}
            {(run.status === "queued" || run.status === "running") && canRun ? (
              <Button size="sm" variant="ghost" onClick={() => void cancel(run)}>
                <X className="mr-1 h-3.5 w-3.5" />
                Cancel
              </Button>
            ) : null}
          </div>
        ),
      },
    ],
    [canRestore, canRun, canManage, cancel, deleteHistory]
  );
  const start = async (policy: BackupPolicy) => {
    try {
      await backupApi.startBackup(database.id, policy.id);
      toast.message("Backup queued");
      await refresh();
    } catch {
      toast.error("Could not queue backup");
    }
  };
  const disableSchedule = async (policy: BackupPolicy) => {
    try {
      await backupApi.updateBackupPolicy(database.id, policy.id, { ...policy, enabled: false });
      toast.message("Backup schedule disabled");
      await refresh();
    } catch {
      toast.error("Could not disable backup schedule");
    }
  };
  const removePolicy = async (policy: BackupPolicy) => {
    try {
      await backupApi.deleteBackupPolicy(database.id, policy.id);
      toast.message("Backup policy deleted");
      await refresh();
    } catch {
      toast.error("Could not delete backup policy");
    }
  };
  return (
    <div className="space-y-4">
      <PanelShell
        title="Backup policy"
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setPolicyOpen(true)}>
              Configure backup
            </Button>
          ) : undefined
        }
      >
        <div>
          {policies.length ? (
            policies.map((policy) => (
              <SettingsControlRow
                key={policy.id}
                title={policy.schedule ? `Schedule: ${policy.schedule}` : "Manual backups"}
                description={
                  policy.enabled
                    ? `Retains ${policy.retentionCount} completed backup${policy.retentionCount === 1 ? "" : "s"}.`
                    : "Schedule disabled. Manual runs remain available."
                }
              >
                <div className="flex items-center gap-1">
                  <Button size="sm" disabled={!canRun} onClick={() => void start(policy)}>
                    <Play className="mr-1 h-3.5 w-3.5" />
                    Run now
                  </Button>
                  {canManage && policy.enabled && policy.schedule ? (
                    <Button size="sm" variant="ghost" onClick={() => void disableSchedule(policy)}>
                      <Pause className="mr-1 h-3.5 w-3.5" />
                      Disable
                    </Button>
                  ) : null}
                  {canManage ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Delete backup policy"
                      onClick={() => void removePolicy(policy)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
              </SettingsControlRow>
            ))
          ) : (
            <SettingsControlRow
              title="No backup policy"
              description="Configure a destination, Storage node, schedule, and retention before running a backup."
            >
              <span className="text-sm text-muted-foreground">Not configured</span>
            </SettingsControlRow>
          )}
        </div>
      </PanelShell>
      <PanelShell title="Backup history">
        <DataTable
          columns={columns}
          data={runs}
          keyFn={(run) => run.id}
          loading={loading}
          emptyMessage="No backups have run for this database."
          horizontalScroll
          minWidth="42rem"
        />
      </PanelShell>
      <PolicyDialog
        open={policyOpen}
        onOpenChange={setPolicyOpen}
        destinations={destinations}
        engine={database.type}
        executors={executors}
        onSave={async (input) => {
          await backupApi.createBackupPolicy(database.id, input);
          toast.message("Backup policy saved");
          setPolicyOpen(false);
          await refresh();
        }}
      />
      <RestoreDialog
        run={restoreRun}
        onOpenChange={(open) => !open && setRestoreRun(null)}
        executors={executors}
        onRestore={async (input) => {
          if (!restoreRun) return;
          await backupApi.restoreBackup(database.id, restoreRun.id, input);
          toast.message("Restore queued");
          setRestoreRun(null);
          await refresh();
        }}
      />
    </div>
  );
}

function PolicyDialog({
  engine,
  open,
  onOpenChange,
  destinations,
  executors,
  onSave,
}: {
  engine: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  destinations: BackupSelectionOption[];
  executors: BackupSelectionOption[];
  onSave: (input: BackupPolicyInput) => Promise<void>;
}) {
  const [destinationId, setDestinationId] = useState("");
  const [executorNodeId, setExecutorNodeId] = useState("");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("database-backups");
  const [stagingStorageConnectionId, setStagingStorageConnectionId] = useState("");
  const [stagingBucket, setStagingBucket] = useState("");
  const [schedule, setSchedule] = useState("0 2 * * *");
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );
  const [retentionCount, setRetentionCount] = useState("7");
  const [saving, setSaving] = useState(false);
  const [limits, setLimits] = useState(defaultLimits);
  const save = async () => {
    if (
      !destinationId ||
      !bucket.trim() ||
      !executorNodeId ||
      !Number.isInteger(Number(retentionCount))
    )
      return toast.error("Choose a destination, bucket, executor, and retention");
    if (Boolean(stagingStorageConnectionId.trim()) !== Boolean(stagingBucket.trim()))
      return toast.error("Staging storage and bucket must be configured together");
    setSaving(true);
    try {
      await onSave({
        destinationId,
        bucket: bucket.trim(),
        prefix: prefix.trim(),
        stagingStorageConnectionId: stagingStorageConnectionId.trim() || null,
        stagingBucket: stagingBucket.trim() || null,
        executorNodeId,
        schedule: schedule.trim() || null,
        timezone: timezone.trim() || "UTC",
        retentionCount: Number(retentionCount),
        limits,
      });
    } catch {
      toast.error("Could not save backup policy");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure database backup</DialogTitle>
          <DialogDescription>
            Backups are queued on the selected Storage node and only completed owned artifacts are
            retained.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Choice
            label="Destination"
            value={destinationId}
            onValueChange={setDestinationId}
            options={destinations}
          />
          <SettingsInlineControl label="Bucket">
            <Input value={bucket} onChange={(event) => setBucket(event.target.value)} />
          </SettingsInlineControl>
          <SettingsInlineControl label="Prefix">
            <Input value={prefix} onChange={(event) => setPrefix(event.target.value)} />
          </SettingsInlineControl>
          {engine === "clickhouse" && (
            <>
              <Choice
                label="S3 staging (required for file destinations)"
                value={stagingStorageConnectionId || "none"}
                onValueChange={(id) => {
                  setStagingStorageConnectionId(id === "none" ? "" : id);
                  if (id === "none") setStagingBucket("");
                }}
                options={[
                  { id: "none", label: "Use the S3 destination directly" },
                  ...destinations.filter(
                    (item) => !["ftp", "ftps", "sftp"].includes(item.provider ?? "")
                  ),
                ]}
              />
              {stagingStorageConnectionId && (
                <SettingsInlineControl label="Staging S3 bucket">
                  <Input
                    value={stagingBucket}
                    onChange={(event) => setStagingBucket(event.target.value)}
                  />
                </SettingsInlineControl>
              )}
            </>
          )}
          <Choice
            label="Storage node"
            value={executorNodeId}
            onValueChange={setExecutorNodeId}
            options={executors}
          />
          <SettingsInlineControl label="Schedule (five-field cron; empty for manual)">
            <Input value={schedule} onChange={(event) => setSchedule(event.target.value)} />
          </SettingsInlineControl>
          <SettingsInlineControl label="Timezone">
            <Input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
          </SettingsInlineControl>
          <SettingsInlineControl label="Completed backups to retain">
            <Input
              inputMode="numeric"
              value={retentionCount}
              onChange={(event) => setRetentionCount(event.target.value)}
            />
          </SettingsInlineControl>
          <details>
            <summary className="cursor-pointer text-sm font-medium">Resource limits</summary>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <SettingsInlineControl label="Workspace (GiB)">
                <Input
                  type="number"
                  min={1}
                  max={1024}
                  value={limits.workspaceBytes / 1024 ** 3}
                  onChange={(e) =>
                    setLimits({ ...limits, workspaceBytes: Number(e.target.value) * 1024 ** 3 })
                  }
                />
              </SettingsInlineControl>
              <SettingsInlineControl label="Timeout (seconds)">
                <Input
                  type="number"
                  min={60}
                  max={86400}
                  value={limits.timeoutSeconds}
                  onChange={(e) => setLimits({ ...limits, timeoutSeconds: Number(e.target.value) })}
                />
              </SettingsInlineControl>
              <SettingsInlineControl label="CPU cores">
                <Input
                  type="number"
                  min={1}
                  max={32}
                  value={limits.cpuCores}
                  onChange={(e) => setLimits({ ...limits, cpuCores: Number(e.target.value) })}
                />
              </SettingsInlineControl>
              <SettingsInlineControl label="Memory (MiB)">
                <Input
                  type="number"
                  min={128}
                  max={262144}
                  value={limits.memoryMb}
                  onChange={(e) => setLimits({ ...limits, memoryMb: Number(e.target.value) })}
                />
              </SettingsInlineControl>
            </div>
          </details>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Save policy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RestoreDialog({
  run,
  onOpenChange,
  executors,
  onRestore,
}: {
  run: BackupRun | null;
  onOpenChange: (open: boolean) => void;
  executors: BackupSelectionOption[];
  onRestore: (input: { executorNodeId: string; newManagedDatabaseName: string }) => Promise<void>;
}) {
  const [executorNodeId, setExecutorNodeId] = useState("");
  const [newManagedDatabaseName, setNewManagedDatabaseName] = useState("");
  const [restoring, setRestoring] = useState(false);
  const restore = async () => {
    if (!executorNodeId || !newManagedDatabaseName.trim())
      return toast.error("Choose the Storage node and a new target");
    setRestoring(true);
    try {
      await onRestore({ executorNodeId, newManagedDatabaseName: newManagedDatabaseName.trim() });
    } catch {
      toast.error("Could not queue restore");
    } finally {
      setRestoring(false);
    }
  };
  return (
    <Dialog open={Boolean(run)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore backup</DialogTitle>
          <DialogDescription>
            Restores archive {run?.id.slice(0, 8)} into a new target. Existing databases are never
            overwritten.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Choice
            label="Storage node"
            value={executorNodeId}
            onValueChange={setExecutorNodeId}
            options={executors}
          />
          <SettingsInlineControl label="New managed database name">
            <Input
              value={newManagedDatabaseName}
              onChange={(event) => setNewManagedDatabaseName(event.target.value)}
            />
          </SettingsInlineControl>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={restoring} onClick={() => void restore()}>
            {restoring ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Queue restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Choice({
  label,
  value,
  onValueChange,
  options,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: BackupSelectionOption[];
}) {
  return (
    <SettingsInlineControl label={label}>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id} disabled={Boolean(option.disabledReason)}>
              {option.label}
              {option.disabledReason ? ` — ${option.disabledReason}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsInlineControl>
  );
}
