import { describe, expect, it } from 'vitest';
import { mapReasoningEffort, normalizeReasoningEfforts, validateReasoningMap } from './inference-reasoning.service.js';

describe('inference reasoning mappings', () => {
  it('supports many client efforts mapping to one provider effort', () => {
    const efforts = ['low', 'high', 'xhigh', 'ultra'];
    const map = { low: 'low', high: 'high', xhigh: 'max', ultra: 'max' };
    expect(() => validateReasoningMap(efforts, map)).not.toThrow();
    expect(mapReasoningEffort('ultra', 'high', efforts, map)).toEqual({
      clientEffort: 'ultra',
      upstreamEffort: 'max',
    });
    expect(mapReasoningEffort(undefined, 'high', efforts, map)).toEqual({
      clientEffort: 'high',
      upstreamEffort: 'high',
    });
    expect(mapReasoningEffort('max', 'high', efforts, map)).toEqual({
      clientEffort: 'ultra',
      upstreamEffort: 'max',
    });
  });

  it('rejects missing or unadvertised entries', () => {
    expect(() => validateReasoningMap(['high', 'ultra'], { high: 'max' })).toThrow(/does not have an upstream mapping/);
    expect(() => validateReasoningMap(['high'], { high: 'high', hidden: 'max' })).toThrow(/unadvertised/);
    expect(() => mapReasoningEffort('ultra', null, ['high'], { high: 'high' })).toThrow(/unavailable/);
  });

  it('normalizes case and duplicates before publication', () => {
    expect(normalizeReasoningEfforts([' High ', 'high', 'ULTRA'])).toEqual(['high', 'ultra']);
  });
});
