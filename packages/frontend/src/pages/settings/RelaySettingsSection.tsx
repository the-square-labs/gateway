import {
  Activity,
  Ban,
  Cable,
  Cpu,
  Database,
  Gauge,
  MemoryStick,
  Network,
  Plus,
  RefreshCw,
  Save,
  Server,
  Waypoints,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { Switch } from "@/components/ui/switch";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import type {
  AuthProvisioningSettings,
  DashboardRelayInstance,
  DashboardRelaySnapshot,
} from "@/types";

const MAX_HISTORY = 60;
const RELAY_SETTINGS_CACHE_KEY = "req:/api/admin/auth-settings";
const RELAY_STATUS_CACHE_KEY = "req:/api/system/relay";

type CachedRelayStatusResponse = { data: DashboardRelaySnapshot | null };

function percent(value: number, total: number) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

function metric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function admissionLabel(state: string | undefined) {
  switch (state) {
    case "normal":
      return "No throttling";
    case "proxy_throttled":
      return "Proxy fair-share";
    case "database_reserved":
      return "Database reserve";
    case "hard_pressure":
      return "Hard pressure";
    case "disabled":
      return "Disabled";
    default:
      return "Unknown";
  }
}

function sortRelayInstances(instances: DashboardRelayInstance[]): DashboardRelayInstance[] {
  return [...instances].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "local" ? -1 : 1;
    const byName = left.displayName.localeCompare(right.displayName, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    return byName || left.id.localeCompare(right.id);
  });
}

export function RelaySettingsSection({ canEdit }: { canEdit: boolean }) {
  const [initialSnapshot] = useState(() => {
    const cachedSettings = api.getCached<AuthProvisioningSettings>(
      RELAY_SETTINGS_CACHE_KEY,
      Number.POSITIVE_INFINITY
    );
    const cachedStatus = api.getCached<CachedRelayStatusResponse>(
      RELAY_STATUS_CACHE_KEY,
      Number.POSITIVE_INFINITY
    )?.data;
    return { settings: cachedSettings ?? null, status: cachedStatus ?? null };
  });
  const initialRelay = initialSnapshot.settings?.generalSettings.relay;
  const [settings, setSettings] = useState<AuthProvisioningSettings | null>(
    initialSnapshot.settings
  );
  const [initialLoadComplete, setInitialLoadComplete] = useState(settings !== null);
  const [status, setStatus] = useState<DashboardRelaySnapshot | null>(initialSnapshot.status);
  const [history, setHistory] = useState<DashboardRelaySnapshot[]>(() =>
    initialSnapshot.status ? [initialSnapshot.status] : []
  );
  const [dataLanes, setDataLanes] = useState(initialRelay?.dataLanes ?? 4);
  const [readChunkBytes, setReadChunkBytes] = useState(initialRelay?.readChunkBytes ?? 32 * 1024);
  const [assignmentSpreadMode, setAssignmentSpreadMode] = useState<"fixed" | "all">(
    initialRelay?.assignmentSpread?.mode ?? "fixed"
  );
  const [assignmentSpreadCount, setAssignmentSpreadCount] = useState(
    initialRelay?.assignmentSpread?.mode === "fixed" ? initialRelay.assignmentSpread.count : 2
  );
  const [grantTtlHours, setGrantTtlHours] = useState(
    initialSnapshot.settings?.generalSettings.relayGrantTtlHours ?? 4
  );
  const [autoRecovery, setAutoRecovery] = useState(
    initialSnapshot.settings?.generalSettings.relayAutoRecovery ?? true
  );
  const [adaptiveAdmissionEnabled, setAdaptiveAdmissionEnabled] = useState(
    initialRelay?.adaptiveAdmissionEnabled ?? true
  );
  const [proxyTargetPressurePercent, setProxyTargetPressurePercent] = useState(
    initialRelay?.proxyTargetPressurePercent ?? 70
  );
  const [databaseReservePercent, setDatabaseReservePercent] = useState(
    initialRelay?.databaseReservePercent ?? 20
  );
  const [hardPressurePercent, setHardPressurePercent] = useState(
    initialRelay?.hardPressurePercent ?? 95
  );
  const [saving, setSaving] = useState(false);
  const [poolAction, setPoolAction] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollName, setEnrollName] = useState("");
  const [enrollAddress, setEnrollAddress] = useState("");
  const [enrollCommand, setEnrollCommand] = useState("");

  const recordStatus = useCallback((next: DashboardRelaySnapshot | null) => {
    setStatus(next);
    if (!next) return;
    setHistory((current) => {
      const latest = current.at(-1);
      if (latest?.lastProbeAt && latest.lastProbeAt === next.lastProbeAt) return current;
      return [...current, next].slice(-MAX_HISTORY);
    });
  }, []);

  const load = useCallback(async () => {
    const [nextSettings, nextStatus] = await Promise.all([
      api.getAuthProvisioningSettings(),
      api.getRelayStatus(),
    ]);
    setSettings(nextSettings);
    recordStatus(nextStatus);
    setDataLanes(nextSettings.generalSettings.relay?.dataLanes ?? 4);
    setReadChunkBytes(nextSettings.generalSettings.relay?.readChunkBytes ?? 32 * 1024);
    setAssignmentSpreadMode(nextSettings.generalSettings.relay?.assignmentSpread?.mode ?? "fixed");
    setAssignmentSpreadCount(
      nextSettings.generalSettings.relay?.assignmentSpread?.mode === "fixed"
        ? nextSettings.generalSettings.relay.assignmentSpread.count
        : 2
    );
    setGrantTtlHours(nextSettings.generalSettings.relayGrantTtlHours);
    setAutoRecovery(nextSettings.generalSettings.relayAutoRecovery);
    setAdaptiveAdmissionEnabled(
      nextSettings.generalSettings.relay?.adaptiveAdmissionEnabled ?? true
    );
    setProxyTargetPressurePercent(
      nextSettings.generalSettings.relay?.proxyTargetPressurePercent ?? 70
    );
    setDatabaseReservePercent(nextSettings.generalSettings.relay?.databaseReservePercent ?? 20);
    setHardPressurePercent(nextSettings.generalSettings.relay?.hardPressurePercent ?? 95);
  }, [recordStatus]);

  useEffect(() => {
    void load()
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "Failed to load relay settings")
      )
      .finally(() => setInitialLoadComplete(true));
    const timer = window.setInterval(() => {
      void api
        .getRelayStatus()
        .then(recordStatus)
        .catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [load, recordStatus]);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.updateAuthProvisioningSettings({
        generalSettings: {
          relayAutoRecovery: autoRecovery,
          relayGrantTtlHours: grantTtlHours,
          relay: {
            dataLanes,
            readChunkBytes,
            assignmentSpread:
              assignmentSpreadMode === "all"
                ? { mode: "all" }
                : { mode: "fixed", count: assignmentSpreadCount },
            adaptiveAdmissionEnabled,
            proxyTargetPressurePercent,
            databaseReservePercent,
            hardPressurePercent,
          },
        },
      });
      setSettings(updated);
      api.setCache(RELAY_SETTINGS_CACHE_KEY, updated);
      toast.success("Relay settings saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save relay settings");
    } finally {
      setSaving(false);
    }
  };

  const rebalance = async () => {
    if (
      !(await confirm({
        title: "Rebalance Relay Pool?",
        description:
          "Gateway will pre-register every target and verify every source before switching new tunnels to the new assignments.",
        confirmLabel: "Rebalance",
      }))
    )
      return;
    setPoolAction(true);
    try {
      await api.rebalanceRelayPool();
      recordStatus(await api.getRelayStatus());
      toast.success("Relay rebalance staged");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Relay rebalance failed");
    } finally {
      setPoolAction(false);
    }
  };

  const setDrain = async (instance: DashboardRelayInstance, enabled: boolean) => {
    if (
      enabled &&
      !(await confirm({
        title: `Drain ${instance.displayName}?`,
        description:
          "New tunnels will stop using this relay. Existing streams are allowed to finish.",
        confirmLabel: "Drain relay",
        variant: "destructive",
      }))
    )
      return;
    setPoolAction(true);
    try {
      recordStatus(await api.setRelayInstanceDrain(instance.id, enabled));
      toast.success(enabled ? "Relay is draining" : "Relay resumed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Relay action failed");
    } finally {
      setPoolAction(false);
    }
  };

  const forceDisconnect = async (instance: DashboardRelayInstance) => {
    if (
      !(await confirm({
        title: `Disconnect active streams on ${instance.displayName}?`,
        description:
          "This immediately terminates every active tunnel on this relay. Clients may reconnect through another ready instance.",
        confirmLabel: "Force disconnect",
        variant: "destructive",
      }))
    )
      return;
    setPoolAction(true);
    try {
      recordStatus(await api.forceDisconnectRelayInstance(instance.id));
      toast.success("Active relay streams disconnected");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Relay action failed");
    } finally {
      setPoolAction(false);
    }
  };

  const removeRelay = async (instance: DashboardRelayInstance) => {
    if (!instance.nodeId) return;
    if (
      !(await confirm({
        title: `Remove ${instance.displayName}?`,
        description:
          "This removes the drained relay identity and its retired assignment records. The supervisor must be uninstalled separately on the host.",
        confirmLabel: "Remove relay",
        variant: "destructive",
      }))
    )
      return;
    setPoolAction(true);
    try {
      await api.deleteNode(instance.nodeId);
      await load();
      toast.success("Relay node removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Relay removal failed");
    } finally {
      setPoolAction(false);
    }
  };

  const createRelayEnrollment = async () => {
    if (!enrollName.trim() || !enrollAddress.trim()) return;
    setPoolAction(true);
    try {
      const result = await api.createNode({
        type: "relay",
        hostname: "pending",
        displayName: enrollName.trim(),
        serviceAddresses: [enrollAddress.trim()],
        servicePort: 9443,
      });
      const target =
        result.gatewayEnrollmentTargets?.public?.gateway ??
        result.gatewayEnrollmentTargets?.local?.gateway;
      if (!target) throw new Error("Gateway enrollment address is unavailable");
      setEnrollCommand(
        `curl -sSL https://raw.githubusercontent.com/the-square-labs/gateway/main/scripts/setup-relay-node.sh | sudo bash -s -- --gateway ${target} --token ${result.enrollmentToken} --gateway-cert-sha256 ${result.gatewayCertSha256} --advertise-address ${enrollAddress.trim()}`
      );
      toast.success("Relay enrollment created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create relay enrollment");
    } finally {
      setPoolAction(false);
    }
  };

  if (!initialLoadComplete) return <Skeleton />;

  if (!settings) return null;

  const healthy = status?.state === "healthy";
  const memoryLimit = metric(status?.memoryLimitBytes);
  const memoryRss = metric(status?.memoryRssBytes);
  const fdLimit = metric(status?.fileDescriptorLimit);
  const openFDs = metric(status?.openFileDescriptors);
  const pressureColor = status?.admissionState === "normal" ? "#22c55e" : "#f59e0b";
  const persistedRelay = settings.generalSettings.relay;
  const persistedDataLanes = persistedRelay?.dataLanes ?? 4;
  const persistedReadChunkBytes = persistedRelay?.readChunkBytes ?? 32 * 1024;
  const persistedAssignmentSpread = persistedRelay?.assignmentSpread ?? {
    mode: "fixed" as const,
    count: 2,
  };
  const hasChanges =
    dataLanes !== persistedDataLanes ||
    readChunkBytes !== persistedReadChunkBytes ||
    assignmentSpreadMode !== persistedAssignmentSpread.mode ||
    (assignmentSpreadMode === "fixed" &&
      (persistedAssignmentSpread.mode !== "fixed" ||
        assignmentSpreadCount !== persistedAssignmentSpread.count)) ||
    adaptiveAdmissionEnabled !== (persistedRelay?.adaptiveAdmissionEnabled ?? true) ||
    proxyTargetPressurePercent !== (persistedRelay?.proxyTargetPressurePercent ?? 70) ||
    databaseReservePercent !== (persistedRelay?.databaseReservePercent ?? 20) ||
    hardPressurePercent !== (persistedRelay?.hardPressurePercent ?? 95) ||
    grantTtlHours !== settings.generalSettings.relayGrantTtlHours ||
    autoRecovery !== settings.generalSettings.relayAutoRecovery;
  const instances = sortRelayInstances(status?.instances ?? []);
  const readyInstances = instances.filter((instance) => instance.state === "ready").length;
  const faultDomains = new Set(instances.map((instance) => instance.faultDomainId)).size;
  const hottestInstance = instances.reduce<DashboardRelayInstance | null>(
    (current, instance) =>
      !current || metric(instance.health?.pressurePercent) > metric(current.health?.pressurePercent)
        ? instance
        : current,
    null
  );
  const instanceColumns: SimpleTableColumn<DashboardRelayInstance>[] = [
    {
      id: "name",
      header: "Instance",
      render: (row) => (
        <div>
          <div className="font-medium">{row.displayName}</div>
          <div className="text-xs text-muted-foreground">
            {row.kind === "local"
              ? "Gateway host"
              : `${row.advertisedAddresses.join(", ")}:${row.servicePort}`}
          </div>
        </div>
      ),
    },
    {
      id: "state",
      header: "State",
      render: (row) => {
        const policyExpired = Boolean(
          row.kind === "remote" &&
            row.policyExpiresAt &&
            Date.parse(row.policyExpiresAt) <= Date.now()
        );
        return (
          <div className="space-y-1">
            <Badge
              variant={
                row.state === "ready" && !policyExpired
                  ? "success"
                  : row.state === "draining" || row.state === "synchronizing"
                    ? "warning"
                    : "destructive"
              }
            >
              {policyExpired ? "policy expired" : row.state}
            </Badge>
            {row.updateStep && !["pending", "ready"].includes(row.updateStep.state) && (
              <div className="text-xs text-muted-foreground">
                Update: {row.updateStep.state}
                {row.updateStep.error ? ` · ${row.updateStep.error}` : ""}
              </div>
            )}
          </div>
        );
      },
    },
    {
      id: "assignments",
      header: "Assignments",
      render: (row) => `${row.activeAssignments} active`,
    },
    {
      id: "load",
      header: "Load",
      render: (row) =>
        `${metric(row.health?.activeTunnels)} tunnels · ${metric(row.health?.pressurePercent)}%`,
    },
    {
      id: "version",
      header: "Version",
      render: (row) => (
        <div>
          <div>
            {row.buildVersion ??
              (row.kind === "local" ? (status?.local?.relayBuildVersion ?? "unknown") : "unknown")}
          </div>
          <div className="text-xs text-muted-foreground">
            protocol v{row.protocolMajor ?? "-"} · policy r{row.appliedPolicyRevision}
          </div>
        </div>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      render: (row) =>
        row.kind === "remote" ? (
          <div className="flex justify-end gap-2">
            {row.state === "draining" && metric(row.health?.activeTunnels) > 0 && (
              <Button
                size="sm"
                variant="destructive"
                disabled={!canEdit || poolAction}
                onClick={() => void forceDisconnect(row)}
              >
                Force disconnect
              </Button>
            )}
            <Button
              variant="outline"
              disabled={!canEdit || poolAction}
              onClick={() => void setDrain(row, row.state !== "draining")}
            >
              {row.state === "draining" ? "Resume" : "Drain"}
            </Button>
            {["draining", "offline", "error"].includes(row.state) &&
              metric(row.health?.activeTunnels) === 0 &&
              row.activeAssignments === 0 && (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!canEdit || poolAction}
                  onClick={() => void removeRelay(row)}
                >
                  Remove
                </Button>
              )}
          </div>
        ) : (
          <Badge variant="secondary">Local</Badge>
        ),
    },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border border-border bg-card p-3 text-sm">
        <span className="font-medium">Relay Pool</span>
        <Badge
          variant={
            healthy
              ? "success"
              : status?.state === "recovering" || status?.state === "degraded"
                ? "warning"
                : "destructive"
          }
        >
          {status?.state ?? "unavailable"}
        </Badge>
        <Badge variant="secondary">build {status?.relayBuildVersion ?? "unknown"}</Badge>
        <Badge variant="secondary">protocol v{status?.protocolMajor ?? "-"}</Badge>
        <Badge variant="secondary">
          {readyInstances}/{instances.length} ready
        </Badge>
        <Badge variant={faultDomains > 1 ? "success" : "secondary"}>
          {faultDomains} fault domain{faultDomains === 1 ? "" : "s"}
        </Badge>
        <Badge variant="secondary">
          worst {metric(status?.worstPressurePercent)}%
          {hottestInstance ? ` · ${hottestInstance.displayName}` : ""}
        </Badge>
        <Badge variant={status?.admissionState === "normal" ? "secondary" : "warning"}>
          {admissionLabel(status?.admissionState)}
        </Badge>
      </div>

      <PanelShell
        icon={<Server className="h-4 w-4" />}
        title="Relay instances"
        description="One logical Relay Pool; active assignments use separate physical hosts"
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => setEnrollOpen(true)}
              disabled={!canEdit || poolAction}
            >
              <Plus className="h-4 w-4" />
              Add relay node
            </Button>
            <Button
              onClick={() => void rebalance()}
              disabled={!canEdit || poolAction || !status?.rebalanceAvailable}
            >
              <RefreshCw className="h-4 w-4" />
              Rebalance
            </Button>
          </>
        }
      >
        <SimpleTable
          columns={instanceColumns}
          rows={instances}
          getRowKey={(row) => row.id}
          emptyMessage="No relay instances are registered"
        />
        {status?.state === "rebalance_available" && (
          <p className="border-t border-border p-3 text-sm text-warning">
            Relay capacity or workload spread changed. Existing Secure Links stay unchanged until
            you rebalance explicitly.
          </p>
        )}
        {status?.staging && status.staging.length > 0 && (
          <p className="border-t border-border p-3 text-sm text-warning">
            Rebalance is verifying {status.staging.length} staged assignment generation
            {status.staging.length === 1 ? "" : "s"} before activation.
          </p>
        )}
        {status?.update && (
          <p className="border-t border-border p-3 text-sm text-muted-foreground">
            Pool update to {status.update.targetVersion}: {status.update.state}
            {status.update.error ? ` · ${status.update.error}` : ""}
          </p>
        )}
      </PanelShell>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Tunnel activity</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Active tunnels"
            value={metric(status?.activeTunnels).toLocaleString()}
            icon={Activity}
            history={history.map((sample) => metric(sample.activeTunnels))}
            color="#3b82f6"
            subtitle="Current logical streams"
          />
          <StatCard
            label="Proxy tunnels"
            value={metric(status?.activeProxyTunnels).toLocaleString()}
            icon={Network}
            history={history.map((sample) => metric(sample.activeProxyTunnels))}
            color="#06b6d4"
            subtitle="Secure Link traffic"
          />
          <StatCard
            label="Active DB tunnels"
            value={metric(status?.activeDatabaseTunnels).toLocaleString()}
            icon={Database}
            history={history.map((sample) => metric(sample.activeDatabaseTunnels))}
            color="#8b5cf6"
            subtitle="Gateway and binding streams"
          />
          <StatCard
            label="Registered endpoints"
            value={metric(status?.registeredEndpoints).toLocaleString()}
            icon={Waypoints}
            history={history.map((sample) => metric(sample.registeredEndpoints))}
            color="#22c55e"
            subtitle="Available relay targets"
          />
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Relay resources</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Relay CPU"
            value={`${metric(status?.cpuPressurePercent)}%`}
            icon={Cpu}
            history={history.map((sample) => metric(sample.cpuPressurePercent))}
            sparklineMax={100}
            color="#3b82f6"
            progress={{ percent: metric(status?.cpuPressurePercent) }}
            subtitle="Relay process across available CPUs"
          />
          <StatCard
            label="Resident memory"
            value={formatBytes(memoryRss)}
            icon={MemoryStick}
            history={history.map((sample) => metric(sample.memoryRssBytes))}
            sparklineMax={memoryLimit || undefined}
            color="#8b5cf6"
            progress={memoryLimit > 0 ? { percent: percent(memoryRss, memoryLimit) } : undefined}
            subtitle={
              memoryLimit > 0
                ? `${formatBytes(metric(status?.heapInUseBytes))} heap · ${formatBytes(memoryLimit)} limit`
                : `${formatBytes(metric(status?.heapInUseBytes))} heap · no cgroup limit`
            }
          />
          <StatCard
            label="File descriptors"
            value={openFDs.toLocaleString()}
            icon={Server}
            history={history.map((sample) => metric(sample.openFileDescriptors))}
            sparklineMax={fdLimit || undefined}
            color="#f97316"
            progress={fdLimit > 0 ? { percent: percent(openFDs, fdLimit) } : undefined}
            subtitle={
              fdLimit > 0 ? `of ${fdLimit.toLocaleString()} process limit` : "Limit unavailable"
            }
          />
          <StatCard
            label="Admission pressure"
            value={`${metric(status?.pressurePercent)}%`}
            icon={Gauge}
            history={history.map((sample) => metric(sample.pressurePercent))}
            sparklineMax={100}
            color={pressureColor}
            progress={{ percent: metric(status?.pressurePercent), color: pressureColor }}
            subtitle={admissionLabel(status?.admissionState)}
          />
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Admission & runtime</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Proxy throttled"
            value={metric(status?.throttledProxyTotal).toLocaleString()}
            icon={Ban}
            history={history.map((sample) => metric(sample.throttledProxyTotal))}
            color="#f59e0b"
            subtitle="Cumulative rejected proxy streams"
          />
          <StatCard
            label="Database throttled"
            value={metric(status?.throttledDatabaseTotal).toLocaleString()}
            icon={Cable}
            history={history.map((sample) => metric(sample.throttledDatabaseTotal))}
            color="#ef4444"
            subtitle="Only at the hard safety cutoff"
          />
          <StatCard
            label="Data lanes"
            value={String(persistedDataLanes)}
            icon={Network}
            color="#06b6d4"
            subtitle="Persistent HTTP/2 lanes per daemon"
          />
          <StatCard
            label="Read buffer"
            value={`${Math.round(persistedReadChunkBytes / 1024)} KiB`}
            icon={Activity}
            color="#a855f7"
            subtitle="Pooled per-stream read chunk"
          />
        </div>
      </div>

      <PanelShell
        icon={<Gauge className="h-4 w-4" />}
        title="Relay runtime"
        description="Persisted Gateway settings distributed to the relay data plane"
        actions={
          <Button onClick={save} disabled={!canEdit || saving || !hasChanges}>
            <Save className="h-4 w-4" />
            Save
          </Button>
        }
        dirty={hasChanges}
      >
        <SettingsControlRow
          title="Data lanes"
          description="Persistent HTTP/2 data-plane connections per daemon (1–16)"
          help="Each lane is a persistent connection from one relay daemon to Gateway. More lanes can increase parallel throughput but consume more connections and memory on both sides."
        >
          <NumericInput
            value={dataLanes}
            onChange={setDataLanes}
            min={1}
            max={16}
            disabled={!canEdit || saving}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Read chunk"
          description="Per-tunnel pooled read buffer; protocol frames remain capped at 1 MiB"
          help="Value is bytes per tunnel read buffer, in 4 KiB increments. Raising it increases per-tunnel memory use; it does not raise the 1 MiB protocol-frame limit."
        >
          <NumericInput
            value={readChunkBytes}
            onChange={setReadChunkBytes}
            min={4096}
            max={262144}
            step={4096}
            disabled={!canEdit || saving}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Default workload relay spread"
          description="Active relay instances used by new workload connections; apply bulk changes with Rebalance"
          help="Controls how many healthy relay instances receive each new workload assignment. Fixed count limits fan-out; All ready relays maximizes redundancy and connection use."
          controlsClassName="sm:w-96 sm:min-w-96 sm:max-w-96"
        >
          <div className="flex w-full items-center gap-2">
            <Select
              value={assignmentSpreadMode}
              onValueChange={(value) => setAssignmentSpreadMode(value as "fixed" | "all")}
              disabled={!canEdit || saving}
            >
              <SelectTrigger
                className="min-w-0 flex-1"
                aria-label="Default workload relay spread mode"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fixed">Fixed count</SelectItem>
                <SelectItem value="all">All ready relays</SelectItem>
              </SelectContent>
            </Select>
            {assignmentSpreadMode === "fixed" && (
              <NumericInput
                value={assignmentSpreadCount}
                onChange={setAssignmentSpreadCount}
                min={1}
                max={64}
                disabled={!canEdit || saving}
                aria-label="Default workload relay count"
                className="w-24 shrink-0"
              />
            )}
          </div>
        </SettingsControlRow>
        <SettingsControlRow
          title="Adaptive admission"
          description="Throttle new proxy streams only when measured relay pressure rises"
          help="When enabled, Gateway delays or rejects new lower-priority proxy streams as relays approach capacity while preserving room for database traffic."
        >
          <Switch
            checked={adaptiveAdmissionEnabled}
            onChange={setAdaptiveAdmissionEnabled}
            disabled={!canEdit || saving}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Proxy pressure target"
          description="Start fair-share admission for dominant proxy routes at this measured pressure"
          help="Percentage of measured relay pressure where fair-share throttling begins for new streams on dominant proxy routes."
        >
          <NumericInput
            value={proxyTargetPressurePercent}
            onChange={setProxyTargetPressurePercent}
            min={50}
            max={85}
            disabled={!canEdit || saving || !adaptiveAdmissionEnabled}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Database reserve"
          description="Capacity kept beyond the proxy target for higher-priority database tunnels"
          help="Additional percentage points reserved above the proxy target for database tunnels. Target plus reserve must remain below the hard cutoff."
        >
          <NumericInput
            value={databaseReservePercent}
            onChange={setDatabaseReservePercent}
            min={5}
            max={35}
            disabled={!canEdit || saving || !adaptiveAdmissionEnabled}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Hard pressure cutoff"
          description="Last-resort safety threshold; databases remain admissible until this point"
          help="Percentage of measured pressure where new database tunnels are also rejected. It must exceed the proxy target plus database reserve."
        >
          <NumericInput
            value={hardPressurePercent}
            onChange={setHardPressurePercent}
            min={90}
            max={99}
            disabled={!canEdit || saving || !adaptiveAdmissionEnabled}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Grant lifetime"
          description="Lifetime of newly issued endpoint and connection grants, in hours (1–48)"
          help="A grant authorizes a relay endpoint or connection until it expires. Shorter lifetimes rotate authorization sooner; longer lifetimes reduce renewal frequency."
        >
          <NumericInput
            value={grantTtlHours}
            onChange={setGrantTtlHours}
            min={1}
            max={48}
            disabled={!canEdit || saving}
          />
        </SettingsControlRow>
        <SettingsControlRow
          title="Automatic recovery"
          description="Allow up to three bounded managed relay recovery attempts"
          help="Lets Gateway restart or repair an unhealthy managed relay automatically. Recovery is bounded to three attempts to avoid an endless restart loop."
        >
          <Switch checked={autoRecovery} onChange={setAutoRecovery} disabled={!canEdit || saving} />
        </SettingsControlRow>
      </PanelShell>

      <Dialog
        open={enrollOpen}
        onOpenChange={(open) => {
          setEnrollOpen(open);
          if (!open) setEnrollCommand("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add relay node</DialogTitle>
          </DialogHeader>
          {enrollCommand ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Run this command as root on the relay host:
              </p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap border border-border bg-muted p-3 text-xs">
                {enrollCommand}
              </pre>
              <Button onClick={() => void navigator.clipboard.writeText(enrollCommand)}>
                Copy command
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <Input
                value={enrollName}
                onChange={(event) => setEnrollName(event.target.value)}
                placeholder="Relay name"
              />
              <Input
                value={enrollAddress}
                onChange={(event) => setEnrollAddress(event.target.value)}
                placeholder="Reachable IP or hostname"
              />
              <p className="text-xs text-muted-foreground">
                Gateway does not open firewall or NAT rules. TCP 9443 must be reachable by
                participating nodes.
              </p>
              <Button
                onClick={() => void createRelayEnrollment()}
                disabled={poolAction || !enrollName.trim() || !enrollAddress.trim()}
              >
                Create enrollment
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
