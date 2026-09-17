import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { LoggingClickHouseService } from './logging-clickhouse.service.js';
import type { LoggingMetadataService } from './logging-metadata.service.js';
import type { LoggingValidationError, LoggingValidationService } from './logging-validation.service.js';
export interface LoggingIngestResult {
  accepted: number;
  rejected: number;
  errors: LoggingValidationError[];
}
export class LoggingIngestService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _validation: LoggingValidationService,
    _storage: LoggingClickHouseService,
    _metadata: LoggingMetadataService
  ) {}
  setEventBus(_eventBus: EventBusService): void {}
  async ingest(_params: {
    body: unknown;
    contentLength?: string;
    logs: unknown[];
    environment: {
      id: string;
      retentionDays: number;
      schemaMode: 'loose' | 'strip' | 'reject';
      fieldSchema: any[];
    };
  }): Promise<LoggingIngestResult> {
    return commercialModuleUnavailable();
  }
}
