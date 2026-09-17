import { commercialModuleUnavailable } from '@/edition/unavailable.js';

function disabledLoggingMaintenanceSnapshot(): LoggingMaintenanceSnapshot {
  return {
    configured: false,
    status: 'disabled',
    reason: null,
    checkedAt: null,
    structured: { rows: 0, bytes: 0, maxRows: null, maxSizeBytes: null, usageRatio: 0 },
    internal: { rows: 0, bytes: 0, capBytes: 0, warningBytes: 0 },
    disk: { totalBytes: 0, freeBytes: 0, freeRatio: 1 },
    maintenance: { lastCleanupAt: null, lastCleanupError: null },
  };
}

import type { EventBusService } from '@/services/event-bus.service.js';
import type { LoggingClickHouseService } from './logging-clickhouse.service.js';
import type { LoggingFeatureService } from './logging-feature.service.js';
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
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_storage: LoggingClickHouseService, _feature: LoggingFeatureService) {}
  setEventBus(_eventBus: EventBusService): void {}
  getSnapshot(): LoggingMaintenanceSnapshot {
    return disabledLoggingMaintenanceSnapshot();
  }
  async runGuard(
    _policy?: StructuredLogsPolicy,
    _internalPolicy?: ClickHouseInternalsPolicy
  ): Promise<LoggingMaintenanceSnapshot> {
    return disabledLoggingMaintenanceSnapshot();
  }
  async cleanupStructuredLogs(_policy: StructuredLogsPolicy): Promise<LoggingCleanupResult> {
    return commercialModuleUnavailable();
  }
  async cleanupStructuredLogsAndRefresh(
    _policy: StructuredLogsPolicy,
    _internalPolicy?: ClickHouseInternalsPolicy
  ): Promise<LoggingCleanupResult> {
    return commercialModuleUnavailable();
  }
  async cleanupInternalLogsAndRefresh(
    _policy?: StructuredLogsPolicy,
    _internalPolicy?: ClickHouseInternalsPolicy
  ): Promise<LoggingCleanupResult> {
    return commercialModuleUnavailable();
  }
}
