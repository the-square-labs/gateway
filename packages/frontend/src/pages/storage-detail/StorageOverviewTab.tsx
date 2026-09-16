import { Activity } from "lucide-react";
import { useMemo } from "react";
import { DetailRow } from "@/components/common/DetailRow";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { PanelShell } from "@/components/common/PanelShell";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/ui/stat-card";
import type { ObjectStorageConnection, ObjectStorageMetricSnapshot } from "@/types";
import {
  formatHealthStatusLabel,
  formatMetricValue,
  formatProviderLabel,
  HEALTH_BADGE,
  METRIC_COLORS,
} from "./shared";

interface StorageOverviewTabProps {
  storage: ObjectStorageConnection;
  canViewMonitoring: boolean;
  healthStatus: ObjectStorageConnection["healthStatus"];
  history: ObjectStorageMetricSnapshot[];
  monitoringLoading: boolean;
}

export function StorageOverviewTab({
  storage,
  canViewMonitoring,
  healthStatus,
  history,
  monitoringLoading,
}: StorageOverviewTabProps) {
  const latest = history.at(-1);
  const showMonitoring = canViewMonitoring && healthStatus !== "offline";
  const overviewMetrics = useMemo<
    Array<{
      key: string;
      label: string;
      value: string;
      history: number[];
    }>
  >(() => {
    if (!latest) return [];

    const seriesFor = (key: string) => {
      // Missing/stale samples are gaps, not zero usage. Sparkline accepts only
      // numbers, so show the latest continuous run without bridging a gap.
      const series: number[] = [];
      for (const item of history) {
        const value = item.metrics[key];
        if (typeof value !== "number" || !Number.isFinite(value)) series.length = 0;
        else series.push(value);
      }
      return series;
    };
    const card = (key: string, label: string, value?: string) => ({
      key,
      label,
      value: value ?? formatMetricValue(key, latest.metrics[key] ?? null),
      history: seriesFor(key),
    });
    /** Renders "used / total" when the ceiling is known, plain used otherwise. */
    const usageOf = (usedKey: string, totalKey: string) => {
      const used = latest.metrics[usedKey] ?? null;
      const total = latest.metrics[totalKey] ?? null;
      const usedLabel = formatMetricValue(usedKey, used);
      return total === null ? usedLabel : `${usedLabel} / ${formatMetricValue(totalKey, total)}`;
    };

    const cards = [card("latency_ms", "Latency"), card("bucket_count", "Buckets")];

    // Resource metrics exist only for managed clusters — external connections
    // have no node behind them, so these keys are absent and no card renders.
    if ("cpu_pct" in latest.metrics) {
      cards.push(
        card("cpu_pct", "CPU"),
        card("memory_used_bytes", "Memory", usageOf("memory_used_bytes", "memory_limit_bytes")),
        card("disk_used_bytes", "Disk", usageOf("disk_used_bytes", "disk_total_bytes")),
        card("swap_used_bytes", "Swap", usageOf("swap_used_bytes", "swap_total_bytes")),
        card("network_rx_bytes", "Network RX"),
        card("network_tx_bytes", "Network TX")
      );
    }
    return cards;
  }, [history, latest]);

  return (
    <div className="space-y-4">
      {showMonitoring &&
        (monitoringLoading && !latest ? (
          <div className="flex items-center gap-3 border border-border bg-card p-4 text-sm text-muted-foreground">
            <LoadingSpinner className="" />
            <span>Loading monitoring data...</span>
          </div>
        ) : latest ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {overviewMetrics.map((metric) => (
              <StatCard
                key={metric.key}
                label={metric.label}
                value={metric.value}
                icon={Activity}
                history={metric.history}
                color={METRIC_COLORS[metric.key] ?? "var(--color-primary)"}
              />
            ))}
          </div>
        ) : (
          <div className="border border-border bg-card p-4 text-sm text-muted-foreground">
            Waiting for monitoring data...
          </div>
        ))}

      <div className="grid gap-4 lg:grid-cols-2">
        <PanelShell
          title="Connection Details"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow
            label="Endpoint"
            value={
              <span className="block break-all font-mono">
                {storage.endpoint || formatProviderLabel(storage.provider)}
              </span>
            }
          />
          <DetailRow
            label="Region"
            value={<span className="font-mono">{storage.region || "-"}</span>}
          />
          <DetailRow
            label="Access Key"
            value={<span className="font-mono">{storage.accessKeyId || "-"}</span>}
          />
          <DetailRow
            label="Default Bucket"
            value={<span className="font-mono">{storage.defaultBucket || "-"}</span>}
          />
          <DetailRow
            label="Path Style"
            value={
              <Badge variant={storage.forcePathStyle ? "success" : "secondary"}>
                {storage.forcePathStyle ? "Enabled" : "Disabled"}
              </Badge>
            }
          />
        </PanelShell>

        <PanelShell
          title="Storage Information"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow
            label="Status"
            value={
              <Badge variant={HEALTH_BADGE[healthStatus] ?? "secondary"}>
                {formatHealthStatusLabel(healthStatus)}
              </Badge>
            }
          />
          <DetailRow
            label="Provider"
            value={<span>{formatProviderLabel(storage.provider)}</span>}
          />
          <DetailRow
            label="Last Check"
            value={
              storage.lastHealthCheckAt
                ? new Date(storage.lastHealthCheckAt).toLocaleTimeString()
                : "Never"
            }
          />
          {storage.lastError && (
            <DetailRow
              label="Last Error"
              value={
                <span className="block max-w-96 wrap-break-word text-right">
                  {storage.lastError}
                </span>
              }
            />
          )}
        </PanelShell>
      </div>
    </div>
  );
}
