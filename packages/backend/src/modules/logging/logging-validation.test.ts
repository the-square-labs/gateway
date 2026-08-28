import { describe, expect, it } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@/modules/settings/environment-settings.service.js';
import { buildSearchQuery } from './logging-query-builder.js';
import { LoggingValidationService } from './logging-validation.service.js';

const limits = {
  ...DEFAULT_ENVIRONMENT_SETTINGS.loggingIngest,
  maxMessageBytes: 64,
  maxLabels: 4,
  maxFields: 4,
  maxJsonDepth: 2,
};

describe('LoggingValidationService', () => {
  it('defaults missing timestamp and keeps valid loose unknown fields', () => {
    const service = new LoggingValidationService(() => limits);
    const result = service.validateBatch({
      environmentId: '018f0000-0000-7000-8000-000000000001',
      retentionDays: 30,
      schemaMode: 'loose',
      fieldSchema: [],
      logs: [
        {
          severity: 'info',
          message: 'started',
          service: 'api',
          fields: { durationMs: 12 },
        },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.Timestamp).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(result.rows[0]?.FieldNumbers.durationMs).toBe(12);
  });

  it('rejects invalid severities and future timestamps per entry', () => {
    const service = new LoggingValidationService(() => limits);
    const result = service.validateBatch({
      environmentId: '018f0000-0000-7000-8000-000000000001',
      retentionDays: 30,
      schemaMode: 'reject',
      fieldSchema: [],
      logs: [
        { severity: 'notice', message: 'bad' },
        {
          severity: 'info',
          message: 'future',
          timestamp: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
        },
      ],
    });

    expect(result.rows).toHaveLength(0);
    expect(result.errors.map((error) => error.code)).toContain('VALIDATION_ERROR');
    expect(result.errors.map((error) => error.code)).toContain('INVALID_TIMESTAMP');
  });

  it('strips unknown fields in strip mode and rejects unknown fields in reject mode', () => {
    const service = new LoggingValidationService(() => limits);
    const strip = service.validateBatch({
      environmentId: '018f0000-0000-7000-8000-000000000001',
      retentionDays: 30,
      schemaMode: 'strip',
      fieldSchema: [{ key: 'region', location: 'label', type: 'string', required: false }],
      logs: [{ severity: 'info', message: 'ok', labels: { region: 'eu', unknown: 'drop' } }],
    });
    const reject = service.validateBatch({
      environmentId: '018f0000-0000-7000-8000-000000000001',
      retentionDays: 30,
      schemaMode: 'reject',
      fieldSchema: [{ key: 'region', location: 'label', type: 'string', required: false }],
      logs: [{ severity: 'info', message: 'bad', labels: { unknown: 'nope' } }],
    });

    expect(strip.rows[0]?.Labels).toEqual({ region: 'eu' });
    expect(reject.rows).toHaveLength(0);
    expect(reject.errors[0]?.code).toBe('UNKNOWN_FIELD');
  });

  it('rejects unsafe keys and overly deep json', () => {
    const service = new LoggingValidationService(() => limits);
    const result = service.validateBatch({
      environmentId: '018f0000-0000-7000-8000-000000000001',
      retentionDays: 30,
      schemaMode: 'loose',
      fieldSchema: [{ key: 'payload', location: 'field', type: 'json', required: false }],
      logs: [
        {
          severity: 'info',
          message: 'bad',
          labels: { constructor: 'bad' },
          fields: { payload: { a: { b: { c: true } } } },
        },
      ],
    });

    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['INVALID_KEY', 'JSON_TOO_DEEP']));
  });
});

describe('logging query builder', () => {
  it('uses query params for user values and rejects unknown fields outside loose mode', () => {
    const built = buildSearchQuery({
      database: 'gateway_logs',
      table: 'logs',
      environmentId: '018f0000-0000-7000-8000-000000000001',
      schemaMode: 'reject',
      fieldSchema: [{ key: 'durationMs', location: 'field', type: 'number', required: false }],
      query: {
        message: "anything' OR 1=1",
        fields: { durationMs: { op: 'gte', value: 10 } },
        limit: 100,
      },
    });

    expect(built.query).not.toContain("anything' OR 1=1");
    expect(built.queryParams.message).toBe("anything' OR 1=1");
    expect(() =>
      buildSearchQuery({
        database: 'gateway_logs',
        table: 'logs',
        environmentId: '018f0000-0000-7000-8000-000000000001',
        schemaMode: 'reject',
        fieldSchema: [],
        query: { fields: { nope: { op: 'eq', value: 'x' } }, limit: 100 },
      })
    ).toThrow(AppError);
  });
});
