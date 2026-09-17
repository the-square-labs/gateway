import type { LoggingFieldDefinition } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { EnvironmentSettings } from '@/modules/settings/environment-settings.schemas.js';
import type { LoggingClickHouseRow } from './logging-storage.types.js';
export interface LoggingValidationError {
  index: number;
  code: string;
  path: string;
  message: string;
}
export interface LoggingValidationResult {
  rows: LoggingClickHouseRow[];
  errors: LoggingValidationError[];
}
export class LoggingValidationService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_getLimits?: () => EnvironmentSettings['loggingIngest']) {}
  enforceBodySize(_contentLength: string | undefined, _body: unknown): void {
    commercialModuleUnavailable();
  }
  validateBatch(_params: {
    logs: unknown[];
    environmentId: string;
    retentionDays: number;
    schemaMode: 'loose' | 'strip' | 'reject';
    fieldSchema: LoggingFieldDefinition[];
  }): LoggingValidationResult {
    return commercialModuleUnavailable();
  }
}
