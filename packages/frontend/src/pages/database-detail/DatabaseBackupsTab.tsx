import { DatabaseBackup, History, Loader2, Pause, Play, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow, SettingsInlineControl } from "@/components/common/SettingsControlRow";
import { Badge, type BadgeProps } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes, formatDateTime } from "@/lib/utils";
import { api } from "@/services/api";
import type { BackupPolicy, BackupPolicyInput, BackupRun, BackupRunStatus } from "@/types/backups";
import type { DatabaseConnection } from "@/types/databases";

const defaultLimits = {
  workspaceBytes: 20 * 1024 ** 3,
  timeoutSeconds: 3600,
  cpuCores: 1,
  memoryMb: 1024,
};

const RUN_STATUS_BADGE: Record<BackupRunStatus, { label: string; variant: BadgeProps["variant"] }> =
  {
    queued: { label: "Queued", variant: "secondary" },
    running: { label: "Running", variant: "info" },
    completed: { label: "Completed", variant: "success" },
    failed: { label: "Failed", variant: "destructive" },
    cancelled: { label: "Cancelled", variant: "secondary" },
  };

interface BackupsCache {
  policies: BackupPolicy[];
  runs: BackupRun[];
}

function backupsCacheKey(databaseId: string) {
  return `database:backups:${databaseId}`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

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
  const cacheKey = backupsCacheKey(database.id);
  const [policies, setPolicies] = useState<BackupPolicy[]>(
    () => api.getCached<BackupsCache>(cacheKey)?.policies ?? []
  );
  const [runs, setRuns] = useState<BackupRun[]>(
    () => api.getCached<BackupsCache>(cacheKey)?.runs ?? []
  );
  const [loading, setLoading] = useState(() => api.getCached<BackupsCache>(cacheKey) === undefined);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [restoreRun, setRestoreRun] = useState<BackupRun | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [nextPolicies, nextRuns] = await Promise.all([
        api.listBackupPolicies(database.id),
        api.listBackupRuns(database.id),
      ]);
      api.setCache(cacheKey, { policies: nextPolicies, runs: nextRuns } satisfies BackupsCache);
      setPolicies(nextPolicies);
      setRuns(nextRuns);
    } catch (error) {
      toast.error(errorMessage(error, "Failed to load backups"));
    } finally {
      setLoading(false);
    }
  }, [cacheKey, database.id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) return;
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [runs, refresh]);
  const deleteHistory = useCallback(
    async (run: BackupRun) => {
      try {
        await api.deleteBackupHistory(database.id, run.id);
        toast.success("History entry removed");
        await refresh();
      } catch (error) {
        toast.error(errorMessage(error, "Failed to remove history entry"));
      }
    },
    [database.id, refresh]
  );
  const cancel = useCallback(
    async (run: BackupRun) => {
      try {
        await api.cancelBackup(database.id, run.id);
        toast.success("Cancellation requested");
        await refresh();
      } catch (error) {
        toast.error(errorMessage(error, "Failed to request cancellation"));
      }
    },
    [database.id, refresh]
  );
  const columns = useMemo<DataTableColumn<BackupRun>[]>(
    () => [
      {
        key: "created",
        header: "Started",
        render: (run) => formatDateTime(run.startedAt ?? run.createdAt),
      },
      {
        key: "type",
        header: "Operation",
        render: (run) => (run.direction === "backup" ? "Backup" : "Restore"),
      },
      {
        key: "status",
        header: "Status",
        render: (run) => (
          <Badge variant={RUN_STATUS_BADGE[run.status].variant}>
            {RUN_STATUS_BADGE[run.status].label}
          </Badge>
        ),
      },
      {
        key: "details",
        header: "Details",
        render: (run) => (
          <span className="text-muted-foreground">
            {run.error ??
              (run.status === "queued" || run.status === "running"
                ? run.phase.replaceAll("_", " ")
                : run.artifactsDeletedAt
                  ? "Artifacts removed by retention"
                  : "—")}
          </span>
        ),
      },
      {
        key: "size",
        header: "Size",
        align: "right",
        render: (run) => (Number(run.bytes) > 0 ? formatBytes(Number(run.bytes)) : "—"),
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
                <RotateCcw />
                Restore
              </Button>
            ) : null}
            {canManage &&
            !["queued", "running"].includes(run.status) &&
            (!run.manifest || run.artifactsDeletedAt) ? (
              <Button size="sm" variant="ghost" onClick={() => void deleteHistory(run)}>
                <Trash2 />
                Remove
              </Button>
            ) : null}
            {(run.status === "queued" || run.status === "running") && canRun ? (
              <Button size="sm" variant="ghost" onClick={() => void cancel(run)}>
                <X />
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
      await api.startBackup(database.id, policy.id);
      toast.success("Backup queued");
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error, "Failed to queue backup"));
    }
  };
  const setScheduleEnabled = async (policy: BackupPolicy, enabled: boolean) => {
    try {
      await api.updateBackupPolicy(database.id, policy.id, policyInput(policy, enabled));
      toast.success(enabled ? "Backup schedule enabled" : "Backup schedule disabled");
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error, "Failed to update backup schedule"));
    }
  };
  const removePolicy = async (policy: BackupPolicy) => {
    const ok = await confirm({
      title: "Delete backup policy",
      description:
        "Scheduled backups for this policy will stop. Completed backups stay in the destination storage.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await api.deleteBackupPolicy(database.id, policy.id);
      toast.success("Backup policy deleted");
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error, "Failed to delete backup policy"));
    }
  };
  const destinationLabel = (policy: BackupPolicy) =>
    destinations.find((item) => item.id === policy.destinationId)?.label ?? "Storage";
  return (
    <div className="space-y-4">
      <PanelShell
        icon={<DatabaseBackup className="h-4 w-4" />}
        title="Backup policies"
        description="Where backups are stored, which node runs them, and how many are kept."
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setPolicyOpen(true)}>
              Add policy
            </Button>
          ) : undefined
        }
      >
        {loading ? (
          <div
            className="flex min-h-16 items-center justify-between gap-4 px-4 py-3"
            aria-busy="true"
            aria-label="Loading backup policies"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-4/5" />
            </div>
            <Skeleton className="h-8 w-24 shrink-0" />
          </div>
        ) : policies.length ? (
          policies.map((policy) => (
            <SettingsControlRow
              key={policy.id}
              title={
                policy.schedule
                  ? `Schedule ${policy.schedule} (${policy.timezone})`
                  : "Manual backups"
              }
              description={`${destinationLabel(policy)} / ${policy.bucket}${policy.prefix ? ` / ${policy.prefix}` : ""} · keeps ${policy.retentionCount} backup${policy.retentionCount === 1 ? "" : "s"}${policy.schedule && !policy.enabled ? " · schedule disabled" : ""}`}
            >
              <div className="flex items-center gap-2">
                {canManage && policy.schedule ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void setScheduleEnabled(policy, !policy.enabled)}
                  >
                    {policy.enabled ? <Pause /> : <Play />}
                    {policy.enabled ? "Disable schedule" : "Enable schedule"}
                  </Button>
                ) : null}
                {canManage ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Delete backup policy"
                    onClick={() => void removePolicy(policy)}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
                <Button size="sm" disabled={!canRun} onClick={() => void start(policy)}>
                  <Play />
                  Run now
                </Button>
              </div>
            </SettingsControlRow>
          ))
        ) : (
          <SettingsControlRow
            title="No backup policy"
            description="Add a policy with a destination, Storage node, schedule, and retention before running a backup."
          >
            <span className="text-sm text-muted-foreground">Not configured</span>
          </SettingsControlRow>
        )}
      </PanelShell>
      <PanelShell
        icon={<History className="h-4 w-4" />}
        title="Backup history"
        description="Backup and restore runs for this database."
        bodyClassName="p-0"
      >
        <DataTable
          columns={columns}
          data={runs}
          keyFn={(run) => run.id}
          loading={loading}
          emptyMessage="No backups have run for this database."
          embedded
          horizontalScroll
          minWidth="52rem"
        />
      </PanelShell>
      <PolicyDialog
        open={policyOpen}
        onOpenChange={setPolicyOpen}
        destinations={destinations}
        engine={database.type}
        executors={executors}
        onSave={async (input) => {
          await api.createBackupPolicy(database.id, input);
          toast.success("Backup policy saved");
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
          await api.restoreBackup(database.id, restoreRun.id, input);
          toast.success("Restore queued");
          setRestoreRun(null);
          await refresh();
        }}
      />
    </div>
  );
}

function policyInput(policy: BackupPolicy, enabled: boolean): BackupPolicyInput {
  return {
    destinationId: policy.destinationId,
    bucket: policy.bucket,
    prefix: policy.prefix,
    stagingStorageConnectionId: policy.stagingStorageConnectionId,
    stagingBucket: policy.stagingBucket,
    executorNodeId: policy.executorNodeId,
    schedule: policy.schedule,
    timezone: policy.timezone,
    retentionCount: policy.retentionCount,
    limits: policy.limits,
    enabled,
  };
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
  useEffect(() => {
    if (!open) return;
    setDestinationId("");
    setExecutorNodeId("");
    setBucket("");
    setPrefix("database-backups");
    setStagingStorageConnectionId("");
    setStagingBucket("");
    setSchedule("0 2 * * *");
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    setRetentionCount("7");
    setLimits(defaultLimits);
  }, [open]);
  const retention = Number(retentionCount);
  const save = async () => {
    if (!destinationId || !bucket.trim() || !executorNodeId) {
      toast.error("Choose a destination, bucket, and Storage node");
      return;
    }
    if (!Number.isInteger(retention) || retention < 1) {
      toast.error("Retention must be a whole number of at least 1");
      return;
    }
    if (Boolean(stagingStorageConnectionId) !== Boolean(stagingBucket.trim())) {
      toast.error("Staging storage and bucket must be configured together");
      return;
    }
    setSaving(true);
    try {
      await onSave({
        destinationId,
        bucket: bucket.trim(),
        prefix: prefix.trim(),
        stagingStorageConnectionId: stagingStorageConnectionId || null,
        stagingBucket: stagingBucket.trim() || null,
        executorNodeId,
        schedule: schedule.trim() || null,
        timezone: timezone.trim() || "UTC",
        retentionCount: retention,
        limits,
      });
    } catch (error) {
      toast.error(errorMessage(error, "Failed to save backup policy"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !saving && onOpenChange(nextOpen)}>
      <DialogContent className="flex max-h-[88dvh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add backup policy</DialogTitle>
          <DialogDescription>
            Backups run on the selected Storage node and are uploaded to the destination storage.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pr-1">
          <PanelShell title="Destination" description="Where completed backups are stored.">
            <SettingsControlRow
              title="Storage"
              description="Object storage connection that receives the backups."
            >
              <Choice
                label="Storage"
                value={destinationId}
                onValueChange={setDestinationId}
                options={destinations}
              />
            </SettingsControlRow>
            <SettingsControlRow title="Bucket" description="Bucket inside the destination storage.">
              <Input
                aria-label="Bucket"
                value={bucket}
                onChange={(event) => setBucket(event.target.value)}
              />
            </SettingsControlRow>
            <SettingsControlRow title="Prefix" description="Folder for this database's backups.">
              <Input
                aria-label="Prefix"
                value={prefix}
                onChange={(event) => setPrefix(event.target.value)}
              />
            </SettingsControlRow>
            {engine === "clickhouse" && (
              <SettingsControlRow
                title="S3 staging"
                description="ClickHouse writes backups to S3 natively. A file destination (FTP, SFTP) needs an S3 staging storage."
              >
                <div className="grid w-full gap-3">
                  <Choice
                    label="S3 staging storage"
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
                    <SettingsInlineControl label="Staging bucket">
                      <Input
                        value={stagingBucket}
                        onChange={(event) => setStagingBucket(event.target.value)}
                      />
                    </SettingsInlineControl>
                  )}
                </div>
              </SettingsControlRow>
            )}
          </PanelShell>

          <PanelShell title="Execution" description="Which node runs backups and when.">
            <SettingsControlRow
              title="Storage node"
              description="Node that runs the backup job and uploads the result."
            >
              <Choice
                label="Storage node"
                value={executorNodeId}
                onValueChange={setExecutorNodeId}
                options={executors}
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Schedule"
              description="Five-field cron expression. Leave empty to run backups manually only."
            >
              <div className="grid w-full grid-cols-2 gap-3">
                <SettingsInlineControl label="Cron">
                  <Input value={schedule} onChange={(event) => setSchedule(event.target.value)} />
                </SettingsInlineControl>
                <SettingsInlineControl label="Timezone">
                  <Input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
                </SettingsInlineControl>
              </div>
            </SettingsControlRow>
            <SettingsControlRow
              title="Retention"
              description="Completed backups to keep. Older ones are removed from the destination."
            >
              <Input
                aria-label="Completed backups to keep"
                type="number"
                min={1}
                value={retentionCount}
                onChange={(event) => setRetentionCount(event.target.value)}
              />
            </SettingsControlRow>
          </PanelShell>

          <PanelShell title="Resource limits" description="Limits for one backup or restore job.">
            <SettingsControlRow
              title="Workspace and timeout"
              description="Temporary disk space on the Storage node and the maximum job duration."
            >
              <div className="grid w-full grid-cols-2 gap-3">
                <SettingsInlineControl label="Workspace (GiB)">
                  <Input
                    type="number"
                    min={1}
                    max={1024}
                    value={limits.workspaceBytes / 1024 ** 3}
                    onChange={(event) =>
                      setLimits({
                        ...limits,
                        workspaceBytes: Number(event.target.value) * 1024 ** 3,
                      })
                    }
                  />
                </SettingsInlineControl>
                <SettingsInlineControl label="Timeout (seconds)">
                  <Input
                    type="number"
                    min={60}
                    max={86400}
                    value={limits.timeoutSeconds}
                    onChange={(event) =>
                      setLimits({ ...limits, timeoutSeconds: Number(event.target.value) })
                    }
                  />
                </SettingsInlineControl>
              </div>
            </SettingsControlRow>
            <SettingsControlRow title="CPU and memory" description="Limits of the job container.">
              <div className="grid w-full grid-cols-2 gap-3">
                <SettingsInlineControl label="CPU cores">
                  <Input
                    type="number"
                    min={1}
                    max={32}
                    value={limits.cpuCores}
                    onChange={(event) =>
                      setLimits({ ...limits, cpuCores: Number(event.target.value) })
                    }
                  />
                </SettingsInlineControl>
                <SettingsInlineControl label="Memory (MiB)">
                  <Input
                    type="number"
                    min={128}
                    max={262144}
                    value={limits.memoryMb}
                    onChange={(event) =>
                      setLimits({ ...limits, memoryMb: Number(event.target.value) })
                    }
                  />
                </SettingsInlineControl>
              </div>
            </SettingsControlRow>
          </PanelShell>
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
          <Button type="button" disabled={saving} onClick={() => void save()}>
            {saving && <Loader2 className="animate-spin" />}
            {saving ? "Saving..." : "Save policy"}
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
  const runId = run?.id;
  useEffect(() => {
    if (!runId) return;
    setExecutorNodeId("");
    setNewManagedDatabaseName("");
  }, [runId]);
  const restore = async () => {
    if (!executorNodeId || !newManagedDatabaseName.trim()) {
      toast.error("Choose the Storage node and a name for the new database");
      return;
    }
    setRestoring(true);
    try {
      await onRestore({ executorNodeId, newManagedDatabaseName: newManagedDatabaseName.trim() });
    } catch (error) {
      toast.error(errorMessage(error, "Failed to queue restore"));
    } finally {
      setRestoring(false);
    }
  };
  return (
    <Dialog open={Boolean(run)} onOpenChange={(nextOpen) => !restoring && onOpenChange(nextOpen)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Restore backup</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <DialogDescription>
            Restores the backup from {run ? formatDateTime(run.startedAt ?? run.createdAt) : ""}{" "}
            into a new managed database. Existing databases are never overwritten.
          </DialogDescription>
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Storage node</span>
            <Choice
              label="Storage node"
              value={executorNodeId}
              onValueChange={setExecutorNodeId}
              options={executors}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="backup-restore-database-name">
              New managed database name
            </label>
            <Input
              id="backup-restore-database-name"
              value={newManagedDatabaseName}
              onChange={(event) => setNewManagedDatabaseName(event.target.value)}
              disabled={restoring}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={restoring}
          >
            Cancel
          </Button>
          <Button type="button" disabled={restoring} onClick={() => void restore()}>
            {restoring && <Loader2 className="animate-spin" />}
            {restoring ? "Queueing..." : "Queue restore"}
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
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label={label}>
        <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
      </SelectTrigger>
      <SelectContent className="w-[var(--radix-select-trigger-width)]">
        {options.map((option) => (
          <SelectItem
            key={option.id}
            value={option.id}
            disabled={Boolean(option.disabledReason)}
            description={option.disabledReason}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
