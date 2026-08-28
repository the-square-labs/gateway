import { describe, expect, it } from 'vitest';
import { LoggingFeatureService } from './logging-feature.service.js';

describe('LoggingFeatureService', () => {
  it('keeps reads available while rejecting ingest at confirmed capacity exhaustion', () => {
    const service = new LoggingFeatureService({ isConfigured: () => true });
    service.markAvailable();
    service.markCapacityExhausted('Structured log storage limit is exhausted');

    expect(() => service.requireAvailableForStorage()).not.toThrow();
    expect(() => service.requireAvailableForIngest()).toThrowError(
      expect.objectContaining({ statusCode: 507, code: 'LOGGING_CAPACITY_EXHAUSTED' })
    );
  });
});
