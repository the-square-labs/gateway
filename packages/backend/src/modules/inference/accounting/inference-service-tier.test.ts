import { describe, expect, it } from 'vitest';
import {
  FAST_SERVICE_TIER_MULTIPLIER,
  normalizeServiceTier,
  serviceTierCreditMultiplier,
} from './inference-service-tier.js';

describe('inference service-tier accounting', () => {
  it('normalizes the Codex fast alias to the priority request tier', () => {
    expect(normalizeServiceTier('fast')).toBe('priority');
    expect(normalizeServiceTier(' PRIORITY ')).toBe('priority');
    expect(normalizeServiceTier('default')).toBe('default');
  });

  it('charges Fast only for ChatGPT subscription sources', () => {
    expect(serviceTierCreditMultiplier('subscription', 'openai', 'priority')).toBe(FAST_SERVICE_TIER_MULTIPLIER);
    expect(serviceTierCreditMultiplier('api', 'openai-apikey', 'priority')).toBe(1);
    expect(serviceTierCreditMultiplier('subscription', 'anthropic', 'priority')).toBe(1);
    expect(serviceTierCreditMultiplier('subscription', 'openai', null)).toBe(1);
  });
});
