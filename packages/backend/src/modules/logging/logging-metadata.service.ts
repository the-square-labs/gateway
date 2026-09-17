import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { LoggingClickHouseRow } from './logging-storage.types.js';
export interface LoggingMetadataView {
  services: string[];
  sources: string[];
  labelKeys: string[];
  fieldKeys: string[];
  labelValues: Record<string, string[]>;
}
export class LoggingMetadataService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_db: DrizzleClient) {}
  enqueue(_environmentId: string, _rows: LoggingClickHouseRow[]): void {
    commercialModuleUnavailable();
  }
  async close(): Promise<void> {}
  async get(_environmentId: string): Promise<LoggingMetadataView> {
    return commercialModuleUnavailable();
  }
}
