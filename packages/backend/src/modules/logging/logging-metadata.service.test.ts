import { describe, expect, it } from 'vitest';
import {
  isSupportedLoggingMetadataKey,
  LOGGING_METADATA_KEY_MAX_LENGTH,
  LoggingMetadataService,
} from './logging-metadata.service.js';
import type { LoggingClickHouseRow } from './logging-storage.types.js';

describe('logging metadata key limits', () => {
  it('accepts keys that fit the database column and rejects oversized keys', () => {
    expect(isSupportedLoggingMetadataKey('a'.repeat(LOGGING_METADATA_KEY_MAX_LENGTH))).toBe(true);
    expect(isSupportedLoggingMetadataKey('a'.repeat(LOGGING_METADATA_KEY_MAX_LENGTH + 1))).toBe(false);
    expect(isSupportedLoggingMetadataKey('😀'.repeat(LOGGING_METADATA_KEY_MAX_LENGTH))).toBe(true);
    expect(isSupportedLoggingMetadataKey('😀'.repeat(LOGGING_METADATA_KEY_MAX_LENGTH + 1))).toBe(false);
  });

  it('does not enqueue metadata entries that the database cannot store', () => {
    const service = new LoggingMetadataService({} as never);
    const row: LoggingClickHouseRow = {
      EventId: 'event-1',
      Timestamp: '2026-08-08T00:00:00.000Z',
      EnvironmentId: 'environment-1',
      RetentionDays: 7,
      Service: 'a'.repeat(LOGGING_METADATA_KEY_MAX_LENGTH + 1),
      Source: '',
      Severity: 'info',
      SeverityNumber: 30,
      Message: 'test',
      TraceId: '',
      SpanId: '',
      RequestId: '',
      Labels: {},
      FieldStrings: {},
      FieldNumbers: {},
      FieldBooleans: {},
      FieldDatetimes: {},
      FieldsJson: '{}',
    };

    service.enqueue('environment-1', [row]);

    expect((service as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  });

  it('keeps valid non-BMP metadata while dropping an oversized key in the same batch', () => {
    const service = new LoggingMetadataService({} as never);
    const row: LoggingClickHouseRow = {
      EventId: 'event-2',
      Timestamp: '2026-08-08T00:00:00.000Z',
      EnvironmentId: 'environment-1',
      RetentionDays: 7,
      Service: '😀'.repeat(LOGGING_METADATA_KEY_MAX_LENGTH),
      Source: '😀'.repeat(LOGGING_METADATA_KEY_MAX_LENGTH + 1),
      Severity: 'info',
      SeverityNumber: 30,
      Message: 'test',
      TraceId: '',
      SpanId: '',
      RequestId: '',
      Labels: {},
      FieldStrings: {},
      FieldNumbers: {},
      FieldBooleans: {},
      FieldDatetimes: {},
      FieldsJson: '{}',
    };

    service.enqueue('environment-1', [row]);

    const pending = (service as unknown as { pending: Map<string, { key: string }> }).pending;
    expect([...pending.values()]).toEqual([expect.objectContaining({ key: row.Service })]);
  });
});
