import { describe, expect, it } from 'vitest';
import type { Env } from '@/config/env.js';
import { LoggingFeatureService } from './logging-feature.service.js';

describe('LoggingFeatureService', () => {
  it('keeps reads available while rejecting ingest at confirmed capacity exhaustion', () => {
    const service = new LoggingFeatureService({ CLICKHOUSE_URL: 'http://clickhouse:8123' } as Env);
    service.markAvailable();
    service.markCapacityExhausted('Structured log storage limit is exhausted');

    expect(() => service.requireAvailableForStorage()).not.toThrow();
    expect(() => service.requireAvailableForIngest()).toThrowError(
      expect.objectContaining({ statusCode: 507, code: 'LOGGING_CAPACITY_EXHAUSTED' })
    );
  });
});
