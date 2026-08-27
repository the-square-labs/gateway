import { createChildLogger } from '@/lib/logger.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { ClickHouseStorageStats, LoggingClickHouseService } from './logging-clickhouse.service.js';
import type { LoggingFeatureService } from './logging-feature.service.js';

const logger = createChildLogger('LoggingMaintenance');

export const CLICKHOUSE_INTERNAL_LOG_CAP_BYTES = 512 * 1024 * 1024;
const CLICKHOUSE_INTERNAL_WARNING_RATIO = 0.8;
const CLICKHOUSE_INTERNAL_CLEANUP_TARGET_RATIO = 0.5;
const STRUCTURED_CLEANUP_TARGET_RATIO = 0.8;
const DISK_WARNING_FREE_RATIO = 0.1;
const DISK_EXHAUSTED_FREE_RATIO = 0.05;
const DISK_EXHAUSTED_FREE_BYTES = 1024 * 1024 * 1024;
const CLEANABLE_INTERNAL_LOG_TABLES = new Set([
  'asynchronous_metric_log',
  'background_schedule_pool_log',
  'metric_log',
  'part_log',
  'processors_profile_log',
  'query_log',
  'query_metric_log',
  'text_log',
  'trace_log',
]);

export interface StructuredLogsPolicy {
  enabled: boolean;
  maxRows: number;
  maxSizeBytes: number;
}

export interface ClickHouseInternalsPolicy {
  enabled: boolean;
  maxSizeBytes: number;
}

export type LoggingStorageHealth = 'disabled' | 'healthy' | 'pressure' | 'exhausted' | 'degraded' | 'unavailable';

export interface LoggingMaintenanceSnapshot {
  configured: boolean;
  status: LoggingStorageHealth;
  reason: string | null;
  checkedAt: string | null;
  structured: {
    rows: number;
    bytes: number;
    maxRows: number | null;
    maxSizeBytes: number | null;
    usageRatio: number;
  };
  internal: {
    rows: number;
    bytes: number;
    capBytes: number;
    warningBytes: number;
  };
  disk: {
    totalBytes: number;
    freeBytes: number;
    freeRatio: number;
  };
  maintenance: {
    lastCleanupAt: string | null;
    lastCleanupError: string | null;
  };
}

export interface LoggingCleanupResult {
  itemsCleaned: number;
  spaceFreedBytes: number;
}

export class LoggingMaintenanceService {
  private operationQueue: Promise<void> = Promise.resolve();
  private consecutivePingFailures = 0;
  private snapshot: LoggingMaintenanceSnapshot;
  private eventBus?: EventBusService;

  constructor(
    private readonly storage: LoggingClickHouseService,
    private readonly feature: LoggingFeatureService
  ) {
    this.snapshot = emptySnapshot(storage.isConfigured());
  }

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  getSnapshot(): LoggingMaintenanceSnapshot {
    return structuredClone(this.snapshot);
  }

  async runGuard(
    policy?: StructuredLogsPolicy,
    internalPolicy?: ClickHouseInternalsPolicy
  ): Promise<LoggingMaintenanceSnapshot> {
    return this.serialize(() => this.refreshSnapshot(policy, internalPolicy));
  }

  async cleanupStructuredLogs(policy: StructuredLogsPolicy): Promise<LoggingCleanupResult> {
    return this.serialize(() => this.cleanupStructuredLogsOnce(policy));
  }

  async cleanupStructuredLogsAndRefresh(
    policy: StructuredLogsPolicy,
    internalPolicy?: ClickHouseInternalsPolicy
  ): Promise<LoggingCleanupResult> {
    return this.serialize(async () => {
      const result = await this.cleanupStructuredLogsOnce(policy);
      await this.refreshSnapshot(policy, internalPolicy ? { ...internalPolicy, enabled: false } : undefined);
      return result;
    });
  }

  async cleanupInternalLogsAndRefresh(
    policy?: StructuredLogsPolicy,
    internalPolicy: ClickHouseInternalsPolicy = { enabled: true, maxSizeBytes: CLICKHOUSE_INTERNAL_LOG_CAP_BYTES }
  ): Promise<LoggingCleanupResult> {
    return this.serialize(async () => {
      const result = await this.cleanupInternalLogs(internalPolicy.maxSizeBytes);
      await this.refreshSnapshot(policy, { ...internalPolicy, enabled: false });
      if (result.error) throw new Error(result.error);
      return { itemsCleaned: result.itemsCleaned, spaceFreedBytes: result.spaceFreedBytes };
    });
  }

  private async runGuardOnce(
    policy?: StructuredLogsPolicy,
    internalPolicy?: ClickHouseInternalsPolicy
  ): Promise<LoggingMaintenanceSnapshot> {
    const internalCapBytes = internalPolicy?.maxSizeBytes ?? CLICKHOUSE_INTERNAL_LOG_CAP_BYTES;
    if (!this.storage.isConfigured()) {
      this.snapshot = emptySnapshot(false);
      return this.getSnapshot();
    }

    const pingOk = await this.storage.ping().catch(() => false);
    if (!pingOk) {
      return this.recordPingFailure('ClickHouse health check failed');
    }
    this.consecutivePingFailures = 0;
    const tableExists = await this.storage.structuredTableExists().catch(() => false);
    if (!tableExists) {
      return this.recordStorageUnavailable('ClickHouse structured log table is unavailable');
    }
    this.feature.markAvailable();

    let stats: ClickHouseStorageStats;
    try {
      stats = await this.storage.getStorageStats();
    } catch (error) {
      return this.recordMetricsFailure(error);
    }

    let cleanupError: string | null = null;
    let cleaned = false;
    if (internalPolicy?.enabled && stats.internalBytes > internalCapBytes) {
      const result = await this.cleanupInternalLogs(internalCapBytes);
      cleaned = result.itemsCleaned > 0;
      cleanupError = result.error;
    }
    if (policy?.enabled && exceedsStructuredLimits(stats, policy)) {
      try {
        const result = await this.cleanupStructuredLogsOnce(policy);
        cleaned = cleaned || result.itemsCleaned > 0;
      } catch (error) {
        cleanupError = `Structured log cleanup failed: ${message(error)}`;
      }
    }

    if (cleaned) {
      try {
        stats = await this.storage.getStorageStats();
      } catch (error) {
        return this.recordMetricsFailure(error);
      }
    }
    this.snapshot = this.buildSnapshot(stats, policy, cleanupError, cleaned, internalCapBytes);
    this.updateCapacityGate(this.snapshot);
    return this.getSnapshot();
  }

  private async refreshSnapshot(
    policy?: StructuredLogsPolicy,
    internalPolicy?: ClickHouseInternalsPolicy
  ): Promise<LoggingMaintenanceSnapshot> {
    const previous = this.snapshot;
    const next = await this.runGuardOnce(policy, internalPolicy);
    if (previous.status !== next.status || previous.reason !== next.reason) {
      this.eventBus?.publish('logging.health.changed', { status: next.status, reason: next.reason });
    }
    return next;
  }

  private async cleanupStructuredLogsOnce(policy: StructuredLogsPolicy): Promise<LoggingCleanupResult> {
    if (!policy.enabled) return { itemsCleaned: 0, spaceFreedBytes: 0 };
    const partitions = await this.storage.listStructuredPartitions();
    if (partitions.length <= 1) return { itemsCleaned: 0, spaceFreedBytes: 0 };

    let rows = partitions.reduce((sum, partition) => sum + partition.rows, 0);
    let bytes = partitions.reduce((sum, partition) => sum + partition.bytes, 0);
    const targetRows = policy.maxRows > 0 ? Math.floor(policy.maxRows * STRUCTURED_CLEANUP_TARGET_RATIO) : 0;
    const targetBytes = policy.maxSizeBytes > 0 ? Math.floor(policy.maxSizeBytes * STRUCTURED_CLEANUP_TARGET_RATIO) : 0;
    let itemsCleaned = 0;
    let spaceFreedBytes = 0;

    for (const partition of partitions.slice(0, -1)) {
      if (withinStructuredTargets(rows, bytes, targetRows, targetBytes)) break;
      await this.storage.dropStructuredPartition(partition.partition);
      rows = Math.max(0, rows - partition.rows);
      bytes = Math.max(0, bytes - partition.bytes);
      itemsCleaned += partition.rows;
      spaceFreedBytes += partition.bytes;
    }

    return { itemsCleaned, spaceFreedBytes };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async cleanupInternalLogs(capBytes: number): Promise<LoggingCleanupResult & { error: string | null }> {
    const errors: string[] = [];
    let itemsCleaned = 0;
    let spaceFreedBytes = 0;
    try {
      await this.storage.flushSystemLogs();
    } catch (error) {
      errors.push(`flush failed: ${message(error)}`);
    }

    try {
      const allTables = await this.storage.listInternalLogTables();
      const tables = allTables.filter((table) =>
        CLEANABLE_INTERNAL_LOG_TABLES.has(table.table.replace(/_[0-9]+$/, ''))
      );
      const preferred = tables.filter((table) => table.table.replace(/_[0-9]+$/, '') !== 'query_log');
      const fallback = tables.filter((table) => table.table.replace(/_[0-9]+$/, '') === 'query_log');
      let remaining = tables.reduce((sum, table) => sum + table.bytes, 0);
      const target = capBytes * CLICKHOUSE_INTERNAL_CLEANUP_TARGET_RATIO;
      for (const table of [...preferred, ...fallback]) {
        if (remaining <= target) break;
        try {
          await this.storage.cleanInternalLogTable(table.table);
          remaining = Math.max(0, remaining - table.bytes);
          itemsCleaned += table.rows;
          spaceFreedBytes += table.bytes;
        } catch (error) {
          errors.push(`${table.table}: ${message(error)}`);
        }
      }
    } catch (error) {
      errors.push(message(error));
    }

    const cleanupError = errors.length > 0 ? errors.join('; ') : null;
    if (cleanupError) logger.warn('ClickHouse internal log cleanup was incomplete', { cleanupError });
    return { itemsCleaned, spaceFreedBytes, error: cleanupError };
  }

  private buildSnapshot(
    stats: ClickHouseStorageStats,
    policy: StructuredLogsPolicy | undefined,
    cleanupError: string | null,
    cleaned: boolean,
    internalCapBytes: number
  ): LoggingMaintenanceSnapshot {
    const diskFreeRatio = stats.diskTotalBytes > 0 ? stats.diskFreeBytes / stats.diskTotalBytes : 1;
    const structuredUsageRatio = maxRatio(
      policy?.enabled && policy.maxRows ? stats.structuredRows / policy.maxRows : 0,
      policy?.enabled && policy.maxSizeBytes ? stats.structuredBytes / policy.maxSizeBytes : 0
    );
    const diskExhausted =
      stats.diskTotalBytes > 0 &&
      (diskFreeRatio <= DISK_EXHAUSTED_FREE_RATIO || stats.diskFreeBytes <= DISK_EXHAUSTED_FREE_BYTES);
    const structuredExhausted = Boolean(policy?.enabled && exceedsStructuredLimits(stats, policy));
    const internalPressure = stats.internalBytes >= internalCapBytes * CLICKHOUSE_INTERNAL_WARNING_RATIO;
    const pressure =
      internalPressure ||
      structuredUsageRatio >= CLICKHOUSE_INTERNAL_WARNING_RATIO ||
      diskFreeRatio <= DISK_WARNING_FREE_RATIO;

    let status: LoggingStorageHealth = 'healthy';
    let reason: string | null = null;
    if (diskExhausted) {
      status = 'exhausted';
      reason = 'ClickHouse disk capacity is exhausted';
    } else if (structuredExhausted) {
      status = 'exhausted';
      reason = 'Structured log storage limit is exhausted';
    } else if (cleanupError) {
      status = 'degraded';
      reason = cleanupError;
    } else if (pressure) {
      status = 'pressure';
      reason = internalPressure
        ? `ClickHouse internal logs are approaching their ${Math.round(internalCapBytes / 1024 / 1024)} MiB maintenance cap`
        : structuredUsageRatio >= CLICKHOUSE_INTERNAL_WARNING_RATIO
          ? 'Structured log storage is approaching its configured limit'
          : 'ClickHouse disk free space is running low';
    }

    return {
      configured: true,
      status,
      reason,
      checkedAt: new Date().toISOString(),
      structured: {
        rows: stats.structuredRows,
        bytes: stats.structuredBytes,
        maxRows: policy?.enabled && policy.maxRows > 0 ? policy.maxRows : null,
        maxSizeBytes: policy?.enabled && policy.maxSizeBytes > 0 ? policy.maxSizeBytes : null,
        usageRatio: structuredUsageRatio,
      },
      internal: {
        rows: stats.internalRows,
        bytes: stats.internalBytes,
        capBytes: internalCapBytes,
        warningBytes: internalCapBytes * CLICKHOUSE_INTERNAL_WARNING_RATIO,
      },
      disk: {
        totalBytes: stats.diskTotalBytes,
        freeBytes: stats.diskFreeBytes,
        freeRatio: diskFreeRatio,
      },
      maintenance: {
        lastCleanupAt: cleaned ? new Date().toISOString() : this.snapshot.maintenance.lastCleanupAt,
        lastCleanupError: cleanupError,
      },
    };
  }

  private updateCapacityGate(snapshot: LoggingMaintenanceSnapshot): void {
    if (snapshot.status === 'exhausted') {
      this.feature.markCapacityExhausted(snapshot.reason ?? 'ClickHouse capacity is exhausted');
    } else {
      this.feature.markCapacityAvailable();
    }
  }

  private recordMetricsFailure(error: unknown): LoggingMaintenanceSnapshot {
    const reason = `ClickHouse storage metrics are unavailable: ${message(error)}`;
    this.snapshot = {
      ...this.snapshot,
      configured: true,
      status: 'degraded',
      reason,
      checkedAt: new Date().toISOString(),
      maintenance: { ...this.snapshot.maintenance, lastCleanupError: reason },
    };
    return this.getSnapshot();
  }

  private recordPingFailure(reason: string): LoggingMaintenanceSnapshot {
    this.consecutivePingFailures += 1;
    const unavailable = this.consecutivePingFailures >= 2;
    if (unavailable) this.feature.markUnavailable(reason);
    this.snapshot = {
      ...this.snapshot,
      configured: true,
      status: unavailable ? 'unavailable' : 'degraded',
      reason,
      checkedAt: new Date().toISOString(),
    };
    return this.getSnapshot();
  }

  private recordStorageUnavailable(reason: string): LoggingMaintenanceSnapshot {
    this.feature.markUnavailable(reason);
    this.snapshot = {
      ...this.snapshot,
      configured: true,
      status: 'unavailable',
      reason,
      checkedAt: new Date().toISOString(),
    };
    return this.getSnapshot();
  }
}

function emptySnapshot(configured: boolean): LoggingMaintenanceSnapshot {
  return {
    configured,
    status: configured ? 'degraded' : 'disabled',
    reason: configured ? 'ClickHouse health has not been checked yet' : null,
    checkedAt: null,
    structured: { rows: 0, bytes: 0, maxRows: null, maxSizeBytes: null, usageRatio: 0 },
    internal: {
      rows: 0,
      bytes: 0,
      capBytes: CLICKHOUSE_INTERNAL_LOG_CAP_BYTES,
      warningBytes: CLICKHOUSE_INTERNAL_LOG_CAP_BYTES * CLICKHOUSE_INTERNAL_WARNING_RATIO,
    },
    disk: { totalBytes: 0, freeBytes: 0, freeRatio: 1 },
    maintenance: { lastCleanupAt: null, lastCleanupError: null },
  };
}

function exceedsStructuredLimits(stats: ClickHouseStorageStats, policy: StructuredLogsPolicy): boolean {
  return (
    (policy.maxRows > 0 && stats.structuredRows > policy.maxRows) ||
    (policy.maxSizeBytes > 0 && stats.structuredBytes > policy.maxSizeBytes)
  );
}

function withinStructuredTargets(rows: number, bytes: number, targetRows: number, targetBytes: number): boolean {
  return (targetRows <= 0 || rows <= targetRows) && (targetBytes <= 0 || bytes <= targetBytes);
}

function maxRatio(...ratios: number[]): number {
  return Math.max(0, ...ratios.filter(Number.isFinite));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
