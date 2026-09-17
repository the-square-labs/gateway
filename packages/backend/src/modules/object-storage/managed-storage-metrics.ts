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
