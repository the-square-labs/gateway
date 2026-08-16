import { describe, expect, it } from 'vitest';
import { healthNavigationAttention, nodeNavigationAttention } from './navigation-attention.js';

describe('navigation attention', () => {
  it('prioritizes offline nodes over pending daemon updates', () => {
    expect(nodeNavigationAttention(1, true)).toBe('critical');
    expect(nodeNavigationAttention(0, true)).toBe('warning');
    expect(nodeNavigationAttention(0, false)).toBeNull();
  });

  it('prioritizes offline health over degraded and ignores disabled checks', () => {
    expect(
      healthNavigationAttention([
        { enabled: true, healthStatus: 'degraded' },
        { enabled: true, healthStatus: 'offline' },
      ])
    ).toBe('critical');
    expect(healthNavigationAttention([{ enabled: true, healthStatus: 'degraded' }])).toBe('warning');
    expect(healthNavigationAttention([{ enabled: false, healthStatus: 'offline' }])).toBeNull();
  });
});
