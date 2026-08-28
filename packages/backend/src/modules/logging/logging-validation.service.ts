import { randomUUID } from 'node:crypto';
import type { LoggingFieldDefinition } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { EnvironmentSettings } from '@/modules/settings/environment-settings.schemas.js';
import { getEnvironmentSettingsSnapshot } from '@/modules/settings/environment-settings.service.js';
import { LoggingEventSchema } from './logging.schemas.js';
import { type LoggingClickHouseRow, type LoggingSeverity, SEVERITY_NUMBER } from './logging-storage.types.js';

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_FUTURE_MS = 10 * 60 * 1000;

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
  constructor(
    private readonly getLimits: () => EnvironmentSettings['loggingIngest'] = () =>
      getEnvironmentSettingsSnapshot().loggingIngest
  ) {}

  enforceBodySize(contentLength: string | undefined, body: unknown): void {
    const limits = this.getLimits();
    const headerBytes = contentLength ? Number(contentLength) : 0;
    if (Number.isFinite(headerBytes) && headerBytes > limits.maxBodyBytes) {
      throw new AppError(413, 'LOGGING_PAYLOAD_TOO_LARGE', 'Logging ingest payload is too large');
    }
    const parsedBytes = byteLength(JSON.stringify(body));
    if (parsedBytes > limits.maxBodyBytes) {
      throw new AppError(413, 'LOGGING_PAYLOAD_TOO_LARGE', 'Logging ingest payload is too large');
    }
  }

  validateBatch(params: {
    logs: unknown[];
    environmentId: string;
    retentionDays: number;
    schemaMode: 'loose' | 'strip' | 'reject';
    fieldSchema: LoggingFieldDefinition[];
  }): LoggingValidationResult {
    const limits = this.getLimits();
    if (params.logs.length > limits.maxBatchSize) {
      throw new AppError(400, 'BATCH_TOO_LARGE', 'Logging ingest batch contains too many entries');
    }

    const rows: LoggingClickHouseRow[] = [];
    const errors: LoggingValidationError[] = [];
    for (const [index, raw] of params.logs.entries()) {
      const result = this.validateOne(raw, index, params, limits);
      if ('row' in result) rows.push(result.row);
      else errors.push(...result.errors);
    }
    return { rows, errors };
  }

  private validateOne(
    raw: unknown,
    index: number,
    params: {
      environmentId: string;
      retentionDays: number;
      schemaMode: 'loose' | 'strip' | 'reject';
      fieldSchema: LoggingFieldDefinition[];
    },
    limits = this.getLimits()
  ): { row: LoggingClickHouseRow } | { errors: LoggingValidationError[] } {
    const parsed = LoggingEventSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        errors: parsed.error.errors.map((error) => ({
          index,
          code: 'VALIDATION_ERROR',
          path: error.path.join('.'),
          message: error.message,
        })),
      };
    }

    const event = parsed.data;
    const errors: LoggingValidationError[] = [];
    const timestamp = event.timestamp ? new Date(event.timestamp) : new Date();
    if (timestamp.getTime() > Date.now() + MAX_FUTURE_MS) {
      errors.push(error(index, 'INVALID_TIMESTAMP', 'timestamp', 'Timestamp is too far in the future'));
    }
    const oldestAllowed = Date.now() - params.retentionDays * 24 * 3600 * 1000;
    if (timestamp.getTime() < oldestAllowed) {
      errors.push(
        error(index, 'INVALID_TIMESTAMP', 'timestamp', 'Timestamp is older than this environment retention window')
      );
    }
    if (byteLength(event.message) > limits.maxMessageBytes) {
      errors.push(error(index, 'MESSAGE_TOO_LARGE', 'message', 'Message exceeds the configured byte limit'));
    }

    const schemaByLocation = buildSchemaMap(params.fieldSchema);
    const labels = this.sanitizeMap({
      index,
      path: 'labels',
      values: event.labels ?? {},
      location: 'label',
      schema: schemaByLocation.label,
      mode: params.schemaMode,
      maxEntries: limits.maxLabels,
      limits,
      errors,
    });
    const fields = this.sanitizeMap({
      index,
      path: 'fields',
      values: event.fields ?? {},
      location: 'field',
      schema: schemaByLocation.field,
      mode: params.schemaMode,
      maxEntries: limits.maxFields,
      limits,
      errors,
    });

    for (const definition of params.fieldSchema) {
      if (!definition.required) continue;
      const target = definition.location === 'label' ? labels : fields;
      if (!(definition.key in target)) {
        errors.push(
          error(
            index,
            'REQUIRED_FIELD_MISSING',
            `${definition.location}s.${definition.key}`,
            'Required field is missing'
          )
        );
      }
    }

    if (errors.length > 0) return { errors };

    const fieldStrings: Record<string, string> = {};
    const fieldNumbers: Record<string, number> = {};
    const fieldBooleans: Record<string, 0 | 1> = {};
    const fieldDatetimes: Record<string, string> = {};
    const jsonFields: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(fields)) {
      const definition = schemaByLocation.field.get(key);
      const type = definition?.type ?? inferType(value);
      if (type === 'number') fieldNumbers[key] = Number(value);
      else if (type === 'boolean') fieldBooleans[key] = value === true ? 1 : 0;
      else if (type === 'datetime') fieldDatetimes[key] = toClickHouseDateTime(new Date(String(value)));
      else if (type === 'json') jsonFields[key] = value;
      else fieldStrings[key] = String(value);
    }

    const severity = event.severity as LoggingSeverity;
    return {
      row: {
        EventId: randomUUID(),
        Timestamp: toClickHouseDateTime(timestamp),
        EnvironmentId: params.environmentId,
        RetentionDays: params.retentionDays,
        Service: event.service ?? '',
        Source: event.source ?? '',
        Severity: severity,
        SeverityNumber: SEVERITY_NUMBER[severity],
        Message: event.message,
        TraceId: event.traceId ?? '',
        SpanId: event.spanId ?? '',
        RequestId: event.requestId ?? '',
        Labels: Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, String(value)])),
        FieldStrings: fieldStrings,
        FieldNumbers: fieldNumbers,
        FieldBooleans: fieldBooleans,
        FieldDatetimes: fieldDatetimes,
        FieldsJson: JSON.stringify(jsonFields),
      },
    };
  }

  private sanitizeMap(params: {
    index: number;
    path: string;
    values: Record<string, unknown>;
    location: 'label' | 'field';
    schema: Map<string, LoggingFieldDefinition>;
    mode: 'loose' | 'strip' | 'reject';
    maxEntries: number;
    limits: EnvironmentSettings['loggingIngest'];
    errors: LoggingValidationError[];
  }): Record<string, unknown> {
    const entries = Object.entries(params.values);
    if (entries.length > params.maxEntries) {
      params.errors.push(
        error(params.index, 'TOO_MANY_KEYS', params.path, `${params.path} exceeds the configured key limit`)
      );
      return {};
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      const fieldPath = `${params.path}.${key}`;
      if (!isSafeKey(key, params.limits.maxKeyLength)) {
        params.errors.push(error(params.index, 'INVALID_KEY', fieldPath, 'Key is not allowed'));
        continue;
      }
      const definition = params.schema.get(key);
      if (!definition) {
        if (params.mode === 'reject') {
          params.errors.push(
            error(params.index, 'UNKNOWN_FIELD', fieldPath, 'Field is not allowed by this logging environment')
          );
        }
        if (params.mode === 'strip') continue;
      }

      const expectedType = definition?.type ?? (params.location === 'label' ? 'string' : inferType(value));
      if (!this.isValidValue(value, expectedType, fieldPath, params.index, params.errors, params.limits)) continue;
      sanitized[key] = value;
    }
    return sanitized;
  }

  private isValidValue(
    value: unknown,
    expectedType: string,
    path: string,
    index: number,
    errors: LoggingValidationError[],
    limits: EnvironmentSettings['loggingIngest']
  ): boolean {
    if (byteLength(JSON.stringify(value)) > limits.maxValueBytes) {
      errors.push(error(index, 'VALUE_TOO_LARGE', path, 'Value exceeds the configured byte limit'));
      return false;
    }
    if (
      expectedType === 'string' &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      errors.push(error(index, 'INVALID_TYPE', path, 'Expected string-compatible value'));
      return false;
    }
    if (expectedType === 'number' && typeof value !== 'number') {
      errors.push(error(index, 'INVALID_TYPE', path, 'Expected number value'));
      return false;
    }
    if (expectedType === 'boolean' && typeof value !== 'boolean') {
      errors.push(error(index, 'INVALID_TYPE', path, 'Expected boolean value'));
      return false;
    }
    if (expectedType === 'datetime' && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
      errors.push(error(index, 'INVALID_TYPE', path, 'Expected datetime string value'));
      return false;
    }
    if (expectedType === 'json' && getJsonDepth(value) > limits.maxJsonDepth) {
      errors.push(error(index, 'JSON_TOO_DEEP', path, 'JSON value exceeds the configured depth limit'));
      return false;
    }
    return true;
  }
}

function buildSchemaMap(fieldSchema: LoggingFieldDefinition[]) {
  return {
    label: new Map(fieldSchema.filter((field) => field.location === 'label').map((field) => [field.key, field])),
    field: new Map(fieldSchema.filter((field) => field.location === 'field').map((field) => [field.key, field])),
  };
}

function error(index: number, code: string, path: string, message: string): LoggingValidationError {
  return { index, code, path, message };
}

function isSafeKey(key: string, maxLength: number): boolean {
  return key.length <= maxLength && !key.includes('\0') && !POLLUTION_KEYS.has(key) && KEY_PATTERN.test(key);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function getJsonDepth(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(getJsonDepth));
  return 1 + Math.max(0, ...Object.values(value as Record<string, unknown>).map(getJsonDepth));
}

function inferType(value: unknown): 'string' | 'number' | 'boolean' | 'json' {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value !== null && typeof value === 'object') return 'json';
  return 'string';
}

export function toClickHouseDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}
