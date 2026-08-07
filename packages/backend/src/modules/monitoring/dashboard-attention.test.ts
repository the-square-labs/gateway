import { describe, expect, it } from 'vitest';
import { getDashboardAttentionSeverity } from './dashboard-attention.js';

describe('getDashboardAttentionSeverity', () => {
  it('shows blue attention when all notices are informational', () => {
    expect(getDashboardAttentionSeverity([{ severity: 'info' }])).toBe('info');
  });

  it('promotes the dashboard to yellow when any warning is visible', () => {
    expect(getDashboardAttentionSeverity([{ severity: 'info' }, { severity: 'warning' }])).toBe('warning');
  });

  it('prioritizes critical relay incidents over warnings and information', () => {
    expect(
      getDashboardAttentionSeverity([{ severity: 'info' }, { severity: 'critical' }, { severity: 'warning' }])
    ).toBe('critical');
  });

  it('hides the badge when no notices are visible', () => {
    expect(getDashboardAttentionSeverity([])).toBeNull();
  });
});
