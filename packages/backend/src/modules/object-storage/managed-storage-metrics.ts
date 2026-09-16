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
  timestamp?: number;
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
  storageMountPathSuffix: string;
}

export type ManagedStorageMetrics = Record<string, number | null>;

/** Sums the defined values, or returns null when none of them were present. */
function sumOrNull(values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
}

function storageMount(report: MetricsHealthReport, member: MetricsMember): DiskMountEntry | null {
  return report.diskMounts?.find((mount) => mount.mountPoint?.endsWith(member.storageMountPathSuffix)) ?? null;
}

function mountedStorageMetric(
  nodes: Map<string, MetricsNode>,
  members: MetricsMember[],
  metric: keyof Pick<DiskMountEntry, 'totalBytes' | 'usedBytes' | 'freeBytes'>
): number | null {
  if (members.length === 0) return null;
  const values: number[] = [];
  for (const member of members) {
    const report = nodes.get(member.nodeId)?.healthReport;
    const value = storageMount(report ?? {}, member)?.[metric];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    values.push(value);
  }
  return values.reduce((total, value) => total + value, 0);
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

  // Disk belongs to each managed-storage ext4 image, not the host's largest
  // filesystem. Legacy daemons do not expose those exact mounts, so report an
  // unknown disk value instead of using an unrelated host-level fallback.
  const diskUsed = mountedStorageMetric(nodeById, members, 'usedBytes');
  const diskFree = mountedStorageMetric(nodeById, members, 'freeBytes');
  const diskTotal = mountedStorageMetric(nodeById, members, 'totalBytes');

  // Swap remains host-wide, so each node counts once no matter how many
  // members it hosts.
  const distinctNodeIds = [...new Set(members.map((member) => member.nodeId))];
  const swapUsed: Array<number | null> = [];
  const swapTotal: Array<number | null> = [];

  for (const nodeId of distinctNodeIds) {
    const report = nodeById.get(nodeId)?.healthReport;
    if (!report) continue;
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
    disk_used_bytes: diskUsed,
    disk_free_bytes: diskFree,
    disk_total_bytes: diskTotal,
    swap_used_bytes: sumOrNull(swapUsed),
    swap_total_bytes: sumOrNull(swapTotal),
  };
}
