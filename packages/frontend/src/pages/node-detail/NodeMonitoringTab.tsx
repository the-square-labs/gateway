import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Cpu,
  HardDrive,
  MemoryStick,
  Server,
  Wifi,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GpuMonitoringSection } from "@/components/docker/GpuMonitoringSection";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { formatBytes, formatUptime } from "@/lib/utils";
import { api } from "@/services/api";
import {
  hasGpuMetric,
  hasGpuMonitoringMetrics,
  type NodeGpuDevice,
  type NodeHealthReport,
  type NodeStatsReport,
} from "@/types";

interface TrafficStats {
  statusCodes: { s2xx: number; s3xx: number; s4xx: number; s5xx: number };
  avgResponseTime: number;
  p95ResponseTime: number;
  totalRequests: number;
}

interface Snapshot {
  timestamp: string;
  health: NodeHealthReport | null;
  stats: NodeStatsReport | null;
  traffic: TrafficStats | null;
}

function toRollingDelta(values: number[]): number[] {
  if (values.length < 2) return values;
  return values.slice(1).map((val, i) => Math.max(0, val - values[i]));
}

const MAX_HISTORY = 60;

function finiteNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function fixed(value: unknown, digits: number, fallback = "0") {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : fallback;
}

function gpuMetricHistory(
  snapshots: Snapshot[],
  deviceId: string,
  metric: string,
  value: (device: NodeGpuDevice) => number | undefined
) {
  return snapshots.flatMap((snapshot) => {
    const device = snapshot.health?.gpuDevices?.find((candidate) => candidate.id === deviceId);
    const current = device && hasGpuMetric(device, metric) ? value(device) : undefined;
    return typeof current === "number" && Number.isFinite(current) ? [current] : [];
  });
}

interface NodeMonitoringTabProps {
  nodeId: string;
  nodeStatus: string;
  nodeType?: string;
  initialHealthReport?: NodeHealthReport | null;
  initialStatsReport?: NodeStatsReport | null;
}

function buildInitialSnapshot(
  health: NodeHealthReport | null | undefined,
  stats: NodeStatsReport | null | undefined
): Snapshot | null {
  if (!health && !stats) return null;
  const timestamp = new Date(
    Math.max(health?.timestamp ?? 0, stats?.timestamp ?? 0, Date.now())
  ).toISOString();
  return {
    timestamp,
    health: health ?? null,
    stats: stats ?? null,
    traffic: null,
  };
}

function mergeSeededDiskMounts(snapshot: Snapshot, seededSnapshot: Snapshot | null): Snapshot {
  const seedMounts = seededSnapshot?.health?.diskMounts;
  const seedHealth = seededSnapshot?.health;
  if (!seedHealth || !seedMounts?.length || snapshot.health?.diskMounts?.length) return snapshot;
  return {
    ...snapshot,
    health: {
      ...(snapshot.health ?? seedHealth),
      diskMounts: seedMounts,
    } as NodeHealthReport,
  };
}

export function NodeMonitoringTab({
  nodeId,
  nodeStatus,
  nodeType,
  initialHealthReport,
  initialStatsReport,
}: NodeMonitoringTabProps) {
  const initialSnapshot = buildInitialSnapshot(initialHealthReport, initialStatsReport);
  const initialHealthRef = useRef(initialHealthReport);
  const initialStatsRef = useRef(initialStatsReport);
  initialHealthRef.current = initialHealthReport;
  initialStatsRef.current = initialStatsReport;
  const [history, setHistory] = useState<Snapshot[]>(() =>
    initialSnapshot ? [initialSnapshot] : []
  );
  const [latest, setLatest] = useState<Snapshot | null>(() => initialSnapshot);

  useEffect(() => {
    const seededSnapshot = buildInitialSnapshot(initialHealthRef.current, initialStatsRef.current);
    setHistory(seededSnapshot ? [seededSnapshot] : []);
    setLatest(seededSnapshot);

    if (nodeStatus !== "online") return;
    const es = api.createNodeMonitoringStream(nodeId, { focused: true });

    es.addEventListener("connected", (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      const streamHistory = ((data.history ?? []) as Snapshot[]).map((snapshot) =>
        mergeSeededDiskMounts(snapshot, seededSnapshot)
      );
      setHistory(streamHistory.length > 0 ? streamHistory : seededSnapshot ? [seededSnapshot] : []);
      if (streamHistory.length > 0) setLatest(streamHistory[streamHistory.length - 1]);
    });

    es.addEventListener("snapshot", (e: MessageEvent) => {
      const snapshot = JSON.parse(e.data) as Snapshot;
      setHistory((prev) => {
        const next = [...prev, snapshot];
        return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
      });
      setLatest(snapshot);
    });

    return () => es.close();
  }, [nodeId, nodeStatus]);

  if (nodeStatus !== "online") {
    return (
      <div className="flex flex-col items-center gap-2 py-16 border border-border bg-card">
        <p className="text-muted-foreground">Node is offline — monitoring unavailable</p>
      </div>
    );
  }

  if (!latest) {
    return (
      <div
        className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"
        aria-label="Loading node monitoring"
      >
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="space-y-3 border border-border bg-card p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-2 w-full" />
          </div>
        ))}
      </div>
    );
  }

  const health = latest.health;
  const stats = latest.stats;

  // Build sparkline data
  const cpuHist = history.map((h) => h.health?.cpuPercent ?? 0);
  const memHist = history.map((h) => h.health?.systemMemoryUsedBytes ?? 0);
  const activeConnHist = history.map((h) => h.stats?.activeConnections ?? 0);
  const readingHist = history.map((h) => h.stats?.reading ?? 0);
  const writingHist = history.map((h) => h.stats?.writing ?? 0);
  const waitingHist = history.map((h) => h.stats?.waiting ?? 0);
  const diskReadHist = history.map((h) => h.health?.diskReadBytes ?? 0);

  const primaryIface = health?.networkInterfaces?.find((i) => i.name !== "lo");
  const rxHist = history.map(
    (h) => h.health?.networkInterfaces?.find((i) => i.name === primaryIface?.name)?.rxBytes ?? 0
  );

  const memPercent =
    health && health.systemMemoryTotalBytes > 0
      ? `${((health.systemMemoryUsedBytes / health.systemMemoryTotalBytes) * 100).toFixed(1)}%`
      : "0%";

  // Split root mount from other mounts
  const rootMount = health?.diskMounts?.find((m) => m.mountPoint === "/");
  const otherMounts = health?.diskMounts?.filter((m) => m.mountPoint !== "/") ?? [];
  const gpuDevices = (health?.gpuDevices ?? []).filter(hasGpuMonitoringMetrics);

  return (
    <div className="space-y-4">
      {/* Nginx Process Info Bar — nginx nodes only */}
      {nodeType === "nginx" && health && (
        <div className="flex flex-wrap items-center gap-3 p-3 border border-border bg-card text-sm">
          <span className="font-medium">nginx/{health.nginxVersion || "unknown"}</span>
          <Badge variant={health.nginxRunning ? "success" : "destructive"}>
            {health.nginxRunning ? "Running" : "Stopped"}
          </Badge>
          <Badge variant="secondary">{health.workerCount} workers</Badge>
          <Badge variant="secondary">Up {formatUptime(health.nginxUptimeSeconds)}</Badge>
          <Badge variant={health.configValid ? "success" : "destructive"}>
            {health.configValid ? "Config valid" : "Config invalid"}
          </Badge>
          <Badge variant="secondary">RSS {formatBytes(health.nginxRssBytes)}</Badge>
        </div>
      )}

      {/* System Resources */}
      <div>
        <h3 className="text-sm font-semibold mb-2 text-muted-foreground">System Resources</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <StatCard
            label="CPU"
            value={`${fixed(health?.cpuPercent, 1)}%`}
            icon={Cpu}
            history={cpuHist}
            sparklineMax={100}
            color="#3b82f6"
            progress={{ percent: health?.cpuPercent ?? 0 }}
            subtitle={`Load: ${fixed(health?.loadAverage1m, 2)} / ${fixed(health?.loadAverage5m, 2)} / ${fixed(health?.loadAverage15m, 2)}`}
          />
          <StatCard
            label="Memory"
            value={health ? formatBytes(health.systemMemoryUsedBytes) : "0 B"}
            icon={MemoryStick}
            history={memHist}
            sparklineMax={health?.systemMemoryTotalBytes}
            color="#8b5cf6"
            progress={{
              percent:
                health && health.systemMemoryTotalBytes > 0
                  ? (health.systemMemoryUsedBytes / health.systemMemoryTotalBytes) * 100
                  : 0,
            }}
            subtitle={`${memPercent} of ${formatBytes(health?.systemMemoryTotalBytes ?? 0)}`}
          />
          {health && health.swapTotalBytes > 0 && (
            <StatCard
              label="Swap"
              value={formatBytes(health.swapUsedBytes)}
              icon={MemoryStick}
              history={history.map((h) => h.health?.swapUsedBytes ?? 0)}
              sparklineMax={health.swapTotalBytes}
              color="#d946ef"
              progress={{
                percent:
                  health.swapTotalBytes > 0
                    ? (health.swapUsedBytes / health.swapTotalBytes) * 100
                    : 0,
                color: "#d946ef",
              }}
              subtitle={`of ${formatBytes(health.swapTotalBytes)}`}
            />
          )}
          {rootMount && (
            <StatCard
              label="Root Disk"
              value={`${fixed(rootMount.usagePercent, 1)}%`}
              icon={HardDrive}
              history={history.map((h) => {
                const rm = h.health?.diskMounts?.find((m) => m.mountPoint === "/");
                return rm?.usagePercent ?? 0;
              })}
              sparklineMax={100}
              color="#f97316"
              progress={{ percent: finiteNumber(rootMount.usagePercent) }}
              subtitle={`${formatBytes(rootMount.usedBytes)} / ${formatBytes(rootMount.totalBytes)}`}
            />
          )}
        </div>
      </div>

      {gpuDevices.map((gpu, index) => (
        <GpuMonitoringSection
          key={gpu.id}
          gpu={gpu}
          index={index}
          history={(metric, value) => gpuMetricHistory(history, gpu.id, metric, value)}
        />
      ))}

      {/* Traffic — Status Codes & Response Times (nginx only) */}
      {nodeType === "nginx" && latest?.traffic && (
        <div>
          <h3 className="text-sm font-semibold mb-2 text-muted-foreground">Traffic</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard
              label="2xx Success"
              value={String(latest.traffic.statusCodes.s2xx)}
              icon={Check}
              history={toRollingDelta(history.map((h) => h.traffic?.statusCodes.s2xx ?? 0))}
              color="#22c55e"
            />
            <StatCard
              label="3xx Redirect"
              value={String(latest.traffic.statusCodes.s3xx)}
              icon={Activity}
              history={toRollingDelta(history.map((h) => h.traffic?.statusCodes.s3xx ?? 0))}
              color="#3b82f6"
            />
            <StatCard
              label="4xx Client Err"
              value={String(latest.traffic.statusCodes.s4xx)}
              icon={X}
              history={toRollingDelta(history.map((h) => h.traffic?.statusCodes.s4xx ?? 0))}
              color="#f59e0b"
            />
            <StatCard
              label="5xx Server Err"
              value={String(latest.traffic.statusCodes.s5xx)}
              icon={X}
              history={toRollingDelta(history.map((h) => h.traffic?.statusCodes.s5xx ?? 0))}
              color="#ef4444"
            />
            <StatCard
              label="Avg Response"
              value={`${fixed(finiteNumber(latest.traffic.avgResponseTime) * 1000, 0)}ms`}
              icon={Activity}
              history={history.map((h) => (h.traffic?.avgResponseTime ?? 0) * 1000)}
              color="#8b5cf6"
            />
            <StatCard
              label="p95 Response"
              value={`${fixed(finiteNumber(latest.traffic.p95ResponseTime) * 1000, 0)}ms`}
              icon={Activity}
              history={history.map((h) => (h.traffic?.p95ResponseTime ?? 0) * 1000)}
              color="#ec4899"
            />
          </div>
        </div>
      )}

      {/* Connections (nginx only) */}
      {nodeType === "nginx" && (
        <div>
          <h3 className="text-sm font-semibold mb-2 text-muted-foreground">Connections</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            <StatCard
              label="Active"
              value={String(stats?.activeConnections ?? 0)}
              icon={Activity}
              history={activeConnHist}
              color="#3b82f6"
            />
            <StatCard
              label="Reading"
              value={String(stats?.reading ?? 0)}
              icon={ArrowDownToLine}
              history={readingHist}
              color="#22c55e"
            />
            <StatCard
              label="Writing"
              value={String(stats?.writing ?? 0)}
              icon={ArrowUpFromLine}
              history={writingHist}
              color="#f59e0b"
            />
            <StatCard
              label="Waiting"
              value={String(stats?.waiting ?? 0)}
              icon={Server}
              history={waitingHist}
              color="#6b7280"
            />
          </div>
        </div>
      )}

      {/* I/O (all node types) */}
      <div>
        <h3 className="text-sm font-semibold mb-2 text-muted-foreground">I/O</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <StatCard
            label="Disk I/O"
            value={`${formatBytes(health?.diskReadBytes ?? 0)} / ${formatBytes(health?.diskWriteBytes ?? 0)}`}
            icon={HardDrive}
            history={diskReadHist}
            color="#f97316"
            subtitle="Read / Write delta"
          />
          {primaryIface ? (
            <StatCard
              label="Network I/O"
              value={`${formatBytes(primaryIface.rxBytes)} / ${formatBytes(primaryIface.txBytes)}`}
              icon={Wifi}
              history={rxHist}
              color="#06b6d4"
              subtitle={`${primaryIface.name} Rx / Tx`}
            />
          ) : (
            <StatCard label="Network I/O" value="N/A" icon={Wifi} history={[]} color="#6b7280" />
          )}
        </div>
      </div>

      {/* Totals (nginx only) */}
      {nodeType === "nginx" && stats && (
        <div>
          <h3 className="text-sm font-semibold mb-2 text-muted-foreground">Totals</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <StatCard
              label="Accepts"
              value={(stats.accepts ?? 0).toLocaleString()}
              icon={Activity}
              history={toRollingDelta(history.map((h) => h.stats?.accepts ?? 0))}
              color="#22c55e"
              subtitle="delta per poll"
            />
            <StatCard
              label="Handled"
              value={(stats.handled ?? 0).toLocaleString()}
              icon={Activity}
              history={toRollingDelta(history.map((h) => h.stats?.handled ?? 0))}
              color="#3b82f6"
              subtitle="delta per poll"
            />
            <StatCard
              label="Requests"
              value={(stats.requests ?? 0).toLocaleString()}
              icon={Activity}
              history={toRollingDelta(history.map((h) => h.stats?.requests ?? 0))}
              color="#8b5cf6"
              subtitle="delta per poll"
            />
          </div>
        </div>
      )}

      {/* Additional Disk Mounts (non-root) */}
      {otherMounts.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2 text-muted-foreground">Disk Mounts</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {otherMounts.map((mount) => (
              <StatCard
                key={mount.mountPoint}
                label={mount.mountPoint}
                value={`${fixed(mount.usagePercent, 1)}%`}
                icon={HardDrive}
                history={[]}
                color="#f97316"
                progress={{ percent: finiteNumber(mount.usagePercent) }}
                subtitle={`${formatBytes(mount.usedBytes)} / ${formatBytes(mount.totalBytes)} (${mount.device})`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
