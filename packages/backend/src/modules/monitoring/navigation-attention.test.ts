import { describe, expect, it } from 'vitest';
import { healthNavigationAttention, nodeNavigationAttention } from './navigation-attention.js';

describe('navigation attention', () => {
  it('prioritizes offline nodes over pending daemon updates', () => {
    expect(
      nodeNavigationAttention(
        [
          { id: 'node-1', status: 'online' },
          { id: 'node-2', status: 'offline' },
        ],
        new Set(['node-1'])
      )
    ).toBe('critical');
    expect(nodeNavigationAttention([{ id: 'node-1', status: 'online' }], new Set(['node-1']))).toBe('warning');
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
