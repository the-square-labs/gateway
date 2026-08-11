import {
  Activity,
  Ban,
  Cable,
  Cpu,
  Database,
  Gauge,
  MemoryStick,
  Network,
  Save,
  Server,
  Waypoints,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NumericInput } from "@/components/ui/numeric-input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { Switch } from "@/components/ui/switch";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import type { AuthProvisioningSettings, DashboardRelaySnapshot } from "@/types";

const MAX_HISTORY = 60;

function percent(value: number, total: number) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
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

export function RelaySettingsSection({ canEdit }: { canEdit: boolean }) {
  const [settings, setSettings] = useState<AuthProvisioningSettings | null>(null);
  const [status, setStatus] = useState<DashboardRelaySnapshot | null>(null);
  const [history, setHistory] = useState<DashboardRelaySnapshot[]>([]);
  const [dataLanes, setDataLanes] = useState(4);
  const [readChunkBytes, setReadChunkBytes] = useState(32 * 1024);
  const [grantTtlHours, setGrantTtlHours] = useState(4);
  const [autoRecovery, setAutoRecovery] = useState(true);
  const [adaptiveAdmissionEnabled, setAdaptiveAdmissionEnabled] = useState(true);
  const [proxyTargetPressurePercent, setProxyTargetPressurePercent] = useState(70);
  const [databaseReservePercent, setDatabaseReservePercent] = useState(20);
  const [hardPressurePercent, setHardPressurePercent] = useState(95);
  const [saving, setSaving] = useState(false);

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
    void load().catch((error) =>
      toast.error(error instanceof Error ? error.message : "Failed to load relay settings")
    );
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
            adaptiveAdmissionEnabled,
            proxyTargetPressurePercent,
            databaseReservePercent,
            hardPressurePercent,
          },
        },
      });
      setSettings(updated);
      toast.success("Relay settings saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save relay settings");
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return (
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }

  const healthy = status?.state === "healthy";
  const memoryLimit = status?.memoryLimitBytes ?? 0;
  const memoryRss = status?.memoryRssBytes ?? 0;
  const fdLimit = status?.fileDescriptorLimit ?? 0;
  const openFDs = status?.openFileDescriptors ?? 0;
  const pressureColor = status?.admissionState === "normal" ? "#22c55e" : "#f59e0b";
  const persistedRelay = settings.generalSettings.relay;
  const persistedDataLanes = persistedRelay?.dataLanes ?? 4;
  const persistedReadChunkBytes = persistedRelay?.readChunkBytes ?? 32 * 1024;
  const hasChanges =
    dataLanes !== persistedDataLanes ||
    readChunkBytes !== persistedReadChunkBytes ||
    adaptiveAdmissionEnabled !== (persistedRelay?.adaptiveAdmissionEnabled ?? true) ||
    proxyTargetPressurePercent !== (persistedRelay?.proxyTargetPressurePercent ?? 70) ||
    databaseReservePercent !== (persistedRelay?.databaseReservePercent ?? 20) ||
    hardPressurePercent !== (persistedRelay?.hardPressurePercent ?? 95) ||
    grantTtlHours !== settings.generalSettings.relayGrantTtlHours ||
    autoRecovery !== settings.generalSettings.relayAutoRecovery;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border border-border bg-card p-3 text-sm">
        <span className="font-medium">Gateway Relay</span>
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
        <Badge variant={status?.admissionState === "normal" ? "secondary" : "warning"}>
          {admissionLabel(status?.admissionState)}
        </Badge>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Tunnel activity</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Active tunnels"
            value={String(status?.activeTunnels ?? 0)}
            icon={Activity}
            history={history.map((sample) => sample.activeTunnels ?? 0)}
            color="#3b82f6"
            subtitle="Current logical streams"
          />
          <StatCard
            label="Proxy tunnels"
            value={String(status?.activeProxyTunnels ?? 0)}
            icon={Network}
            history={history.map((sample) => sample.activeProxyTunnels ?? 0)}
            color="#06b6d4"
            subtitle="Secure Link traffic"
          />
          <StatCard
            label="Database tunnels"
            value={String(status?.activeDatabaseTunnels ?? 0)}
            icon={Database}
            history={history.map((sample) => sample.activeDatabaseTunnels ?? 0)}
            color="#8b5cf6"
            subtitle="Priority traffic class"
          />
          <StatCard
            label="Registered endpoints"
            value={String(status?.registeredEndpoints ?? 0)}
            icon={Waypoints}
            history={history.map((sample) => sample.registeredEndpoints ?? 0)}
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
            value={`${status?.cpuPressurePercent ?? 0}%`}
            icon={Cpu}
            history={history.map((sample) => sample.cpuPressurePercent ?? 0)}
            sparklineMax={100}
            color="#3b82f6"
            progress={{ percent: status?.cpuPressurePercent ?? 0 }}
            subtitle="Relay process across available CPUs"
          />
          <StatCard
            label="Resident memory"
            value={formatBytes(memoryRss)}
            icon={MemoryStick}
            history={history.map((sample) => sample.memoryRssBytes ?? 0)}
            sparklineMax={memoryLimit || undefined}
            color="#8b5cf6"
            progress={memoryLimit > 0 ? { percent: percent(memoryRss, memoryLimit) } : undefined}
            subtitle={
              memoryLimit > 0
                ? `${formatBytes(status?.heapInUseBytes ?? 0)} heap · ${formatBytes(memoryLimit)} limit`
                : `${formatBytes(status?.heapInUseBytes ?? 0)} heap · no cgroup limit`
            }
          />
          <StatCard
            label="File descriptors"
            value={openFDs.toLocaleString()}
            icon={Server}
            history={history.map((sample) => sample.openFileDescriptors ?? 0)}
            sparklineMax={fdLimit || undefined}
            color="#f97316"
            progress={fdLimit > 0 ? { percent: percent(openFDs, fdLimit) } : undefined}
            subtitle={
              fdLimit > 0 ? `of ${fdLimit.toLocaleString()} process limit` : "Limit unavailable"
            }
          />
          <StatCard
            label="Admission pressure"
            value={`${status?.pressurePercent ?? 0}%`}
            icon={Gauge}
            history={history.map((sample) => sample.pressurePercent ?? 0)}
            sparklineMax={100}
            color={pressureColor}
            progress={{ percent: status?.pressurePercent ?? 0, color: pressureColor }}
            subtitle={admissionLabel(status?.admissionState)}
          />
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Admission & runtime</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Proxy throttled"
            value={(status?.throttledProxyTotal ?? 0).toLocaleString()}
            icon={Ban}
            history={history.map((sample) => sample.throttledProxyTotal ?? 0)}
            color="#f59e0b"
            subtitle="Cumulative rejected proxy streams"
          />
          <StatCard
            label="Database throttled"
            value={(status?.throttledDatabaseTotal ?? 0).toLocaleString()}
            icon={Cable}
            history={history.map((sample) => sample.throttledDatabaseTotal ?? 0)}
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
          title="Adaptive admission"
          description="Throttle new proxy streams only when measured relay pressure rises"
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
        >
          <Switch checked={autoRecovery} onChange={setAutoRecovery} disabled={!canEdit || saving} />
        </SettingsControlRow>
      </PanelShell>
    </div>
  );
}
