import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { LoggingRuntimeSettings } from './logging-settings.service.js';
import type {
  LoggingClickHouseRow,
  LoggingFacets,
  LoggingSearchRequest,
  LoggingSearchResult,
} from './logging-storage.types.js';
export interface ClickHouseStorageStats {
  structuredRows: number;
  structuredBytes: number;
  internalRows: number;
  internalBytes: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
}
export interface ClickHousePartitionStats {
  partition: string;
  rows: number;
  bytes: number;
}
export interface ClickHouseInternalTableStats {
  table: string;
  rows: number;
  bytes: number;
}
export class LoggingClickHouseService {
  async configure(_config: LoggingRuntimeSettings): Promise<void> {}
  isConfigured(): boolean {
    return false;
  }
  async ping(): Promise<boolean> {
    return false;
  }
  async structuredTableExists(): Promise<boolean> {
    return false;
  }
  async ensureSchema(): Promise<void> {}
  async insertLogs(_rows: LoggingClickHouseRow[]): Promise<void> {
    return commercialModuleUnavailable();
  }
  async deleteEnvironmentLogs(_environmentId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async getStorageStats(): Promise<ClickHouseStorageStats> {
    return commercialModuleUnavailable();
  }
  async listStructuredPartitions(): Promise<ClickHousePartitionStats[]> {
    return [];
  }
  async dropStructuredPartition(_partition: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async listInternalLogTables(): Promise<ClickHouseInternalTableStats[]> {
    return [];
  }
  async flushSystemLogs(): Promise<void> {
    return commercialModuleUnavailable();
  }
  async cleanInternalLogTable(_table: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async searchLogs(_params: {
    environmentId: string;
    query: LoggingSearchRequest;
    fieldSchema: any[];
    schemaMode: 'loose' | 'strip' | 'reject';
  }): Promise<{
    data: LoggingSearchResult[];
    nextCursor: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async getFacets(
    _environmentId: string,
    _range?: {
      from?: string;
      to?: string;
    },
    _fieldSchema?: any[]
  ): Promise<LoggingFacets> {
    return commercialModuleUnavailable();
  }
  async close(): Promise<void> {}
}
