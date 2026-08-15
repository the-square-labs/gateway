import { Cpu, HardDrive, MemoryStick } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { HealthBars } from "@/components/ui/health-bars";
import { StatCard as MetricCard } from "@/components/ui/stat-card";
import { nodeTypeLabel } from "@/lib/node-appearance";
import { nodeRoute } from "@/lib/resource-routes";
import { formatBytes } from "@/lib/utils";
import type { Node, NodeHealthReport } from "@/types";
import { effectiveNodeStatus } from "@/types";

export const WARN_THRESHOLD = 80;

function warnStyle(
  pct: number,
  boundaries: { left: boolean; right: boolean }
): {
  style?: React.CSSProperties;
  valueColor?: string;
  progressColor?: string;
} {
  if (pct < WARN_THRESHOLD) return {};
  const warningBorder = "1px solid color-mix(in srgb, var(--color-warning) 60%, transparent)";
  return {
    style: {
      borderTop: warningBorder,
      borderBottom: warningBorder,
      borderLeft: boundaries.left ? warningBorder : undefined,
      borderRight: boundaries.right ? warningBorder : undefined,
      marginTop: "-1px",
      marginBottom: "-1px",
      marginLeft: boundaries.left ? "-1px" : undefined,
      marginRight: boundaries.right ? "-1px" : undefined,
      position: "relative" as const,
      zIndex: 1 as number,
    },
    progressColor: "var(--color-warning)",
  };
}

interface PinnedNodeCardProps {
  node: Node;
  liveHealth?: NodeHealthReport;
  healthHistory?: Array<{ ts: string; status: string }>;
}

export function PinnedNodeCard({ node, liveHealth, healthHistory }: PinnedNodeCardProps) {
  const h = liveHealth ?? node.lastHealthReport;
  const resolvedHealthHistory = healthHistory ?? node.healthHistory ?? [];
  const eStatus = effectiveNodeStatus({ ...node, healthHistory: resolvedHealthHistory });
  const statusColor =
    eStatus === "online" ? "success" : eStatus === "degraded" ? "warning" : "destructive";

  const memPercent =
    h && h.systemMemoryTotalBytes > 0
      ? Math.round((h.systemMemoryUsedBytes / h.systemMemoryTotalBytes) * 100)
      : 0;
  const rootDisk = h?.diskMounts?.find((d) => d.mountPoint === "/");
  const diskPercent = rootDisk ? Math.round(rootDisk.usagePercent) : 0;
  const cpuPercent = h ? Math.min(Math.round(h.cpuPercent), 100) : 0;

  const cpuWarning = cpuPercent >= WARN_THRESHOLD;
  const memoryWarning = memPercent >= WARN_THRESHOLD;
  const diskWarning = diskPercent >= WARN_THRESHOLD;
  const cpuWarn = warnStyle(cpuPercent, { left: true, right: !memoryWarning });
  const memWarn = warnStyle(memPercent, { left: !cpuWarning, right: !diskWarning });
  const diskWarn = warnStyle(diskPercent, { left: !memoryWarning, right: true });

  return (
    <div className="grid grid-cols-4 border border-border bg-card overflow-visible">
      {/* Node info — clickable, navigates to node detail */}
      <Link
        to={nodeRoute(node.slug)}
        className="border-r border-border p-4 space-y-2 overflow-hidden cursor-pointer hover:bg-accent transition-colors"
      >
        <p className="text-xs text-muted-foreground truncate">
          {node.hostname}, {nodeTypeLabel(node.type)}
        </p>
        <p className="text-xl font-bold truncate">{node.displayName || node.hostname}</p>
        <div className="flex items-center gap-2">
          <HealthBars
            history={resolvedHealthHistory}
            currentStatus={node.status}
            showLabels={false}
            className="flex-1"
          />
          <Badge
            variant={statusColor}
            className="uppercase"
            style={{
              border: `1px solid ${eStatus === "online" ? "rgb(16 185 129)" : eStatus === "degraded" ? "var(--color-warning)" : "rgb(248 113 113)"}`,
            }}
          >
            {eStatus}
          </Badge>
        </div>
      </Link>
      <MetricCard
        label="CPU"
        value={h ? `${h.cpuPercent.toFixed(1)}%` : "0%"}
        icon={Cpu}
        progress={{ percent: cpuPercent, color: cpuWarn.progressColor }}
        valueColor={cpuWarn.valueColor}
        className="border-0 border-r border-border"
        style={cpuWarn.style}
      />
      <MetricCard
        label="Memory"
        value={h ? `${memPercent}%` : "0%"}
        icon={MemoryStick}
        progress={{ percent: memPercent, color: memWarn.progressColor }}
        subtitle={
          h
            ? `${formatBytes(h.systemMemoryUsedBytes)} / ${formatBytes(h.systemMemoryTotalBytes)}`
            : undefined
        }
        valueColor={memWarn.valueColor}
        className="border-0 border-r border-border"
        style={memWarn.style}
      />
      <MetricCard
        label="Disk"
        value={rootDisk ? `${diskPercent}%` : "0%"}
        icon={HardDrive}
        progress={{ percent: diskPercent, color: diskWarn.progressColor }}
        subtitle={
          rootDisk
            ? `${formatBytes(rootDisk.usedBytes)} / ${formatBytes(rootDisk.totalBytes)}`
            : undefined
        }
        valueColor={diskWarn.valueColor}
        className="border-0"
        style={diskWarn.style}
      />
    </div>
  );
}
