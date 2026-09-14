/**
 * Derives per-cluster resource metrics for a managed object-storage cluster
 * from data the daemons already report — no extra collection, no extra
 * round-trip. Container-level numbers come from the health report's
 * `containerStats` entry for each member container; disk and swap have no
 * container equivalent and are read at node level.
 *
 * Zero is never treated as a measurement. A daemon that cannot read a metric
 * (for example one running where `/proc/meminfo` does not exist) reports 0,
 * and rendering that as "0 B used" would be a confident lie. Missing data is
 * reported as null so the UI can say so.
 */

export interface ContainerStatsEntry {
  name?: string;
  cpuPercent?: number;
  memoryUsageBytes?: number;
  memoryLimitBytes?: number;
  networkRxBytes?: number;
  networkTxBytes?: number;
  metricsAvailable?: boolean;
}

export interface DiskMountEntry {
  mountPoint?: string;
  totalBytes?: number;
  usedBytes?: number;
  freeBytes?: number;
}

export interface MetricsHealthReport {
  containerStats?: ContainerStatsEntry[];
  diskMounts?: DiskMountEntry[];
  diskFreeBytes?: number;
  swapTotalBytes?: number;
  swapUsedBytes?: number;
}

export interface MetricsNode {
  id: string;
  healthReport: MetricsHealthReport | null;
}

export interface MetricsMember {
  nodeId: string;
  containerName: string;
}

export type ManagedStorageMetrics = Record<string, number | null>;

/** Sums the defined values, or returns null when none of them were present. */
function sumOrNull(values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
}

/**
 * The mount a cluster's data most likely lives on: the largest by capacity.
 * Reports do not say which mount backs the storage volume, and the biggest
 * disk is the closest available proxy on a typical storage host.
 */
function primaryMount(report: MetricsHealthReport): DiskMountEntry | null {
  const mounts = (report.diskMounts ?? []).filter((mount) => (mount.totalBytes ?? 0) > 0);
  if (mounts.length === 0) return null;
  return mounts.reduce((largest, mount) => ((mount.totalBytes ?? 0) > (largest.totalBytes ?? 0) ? mount : largest));
}

export function buildManagedStorageMetrics(nodes: MetricsNode[], members: MetricsMember[]): ManagedStorageMetrics {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const cpu: Array<number | null> = [];
  const memoryUsed: Array<number | null> = [];
  const memoryLimit: Array<number | null> = [];
  const rx: Array<number | null> = [];
  const tx: Array<number | null> = [];

  for (const member of members) {
    const report = nodeById.get(member.nodeId)?.healthReport;
    const stats = report?.containerStats?.find((entry) => entry.name === member.containerName);
    // `metricsAvailable: false` means the daemon saw the container but could
    // not sample it — counting that as zero would drag a cluster average down.
    if (!stats || stats.metricsAvailable === false) continue;
    cpu.push(stats.cpuPercent ?? null);
    memoryUsed.push(stats.memoryUsageBytes ?? null);
    memoryLimit.push(stats.memoryLimitBytes || null);
    rx.push(stats.networkRxBytes ?? null);
    tx.push(stats.networkTxBytes ?? null);
  }

  // Disk and swap are host-wide, so each node counts once no matter how many
  // members it hosts.
  const distinctNodeIds = [...new Set(members.map((member) => member.nodeId))];
  const diskUsed: Array<number | null> = [];
  const diskFree: Array<number | null> = [];
  const diskTotal: Array<number | null> = [];
  const swapUsed: Array<number | null> = [];
  const swapTotal: Array<number | null> = [];

  for (const nodeId of distinctNodeIds) {
    const report = nodeById.get(nodeId)?.healthReport;
    if (!report) continue;
    const mount = primaryMount(report);
    if (mount) {
      diskUsed.push(mount.usedBytes ?? null);
      diskFree.push(mount.freeBytes ?? null);
      diskTotal.push(mount.totalBytes ?? null);
    } else if (report.diskFreeBytes) {
      // No per-mount breakdown: free space is still known, used space is not.
      diskFree.push(report.diskFreeBytes);
    }
    // A zero swap total means "no reading", not "no swap configured" — the
    // daemon reports 0 for both, and reporting 0 B as fact would mislead.
    if (report.swapTotalBytes) {
      swapTotal.push(report.swapTotalBytes);
      swapUsed.push(report.swapUsedBytes ?? null);
    }
  }

  return {
    cpu_pct: sumOrNull(cpu),
    memory_used_bytes: sumOrNull(memoryUsed),
    memory_limit_bytes: sumOrNull(memoryLimit),
    network_rx_bytes: sumOrNull(rx),
    network_tx_bytes: sumOrNull(tx),
    disk_used_bytes: sumOrNull(diskUsed),
    disk_free_bytes: sumOrNull(diskFree),
    disk_total_bytes: sumOrNull(diskTotal),
    swap_used_bytes: sumOrNull(swapUsed),
    swap_total_bytes: sumOrNull(swapTotal),
  };
}
