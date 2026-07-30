import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { __testOnly } from './inference-model-configuration.service.js';

describe('atomic inference model configuration', () => {
  it('rejects enabled sources that cannot be routed', () => {
    expect(() => __testOnly.assertEnabledSourceAvailable(true, false, true)).toThrow(/enabled provider connection/);
    expect(() => __testOnly.assertEnabledSourceAvailable(true, true, false)).toThrow(/available discovered model/);
    expect(() => __testOnly.assertEnabledSourceAvailable(false, false, false)).not.toThrow();
    expect(() => __testOnly.assertEnabledSourceAvailable(true, true, true)).not.toThrow();
  });
});
