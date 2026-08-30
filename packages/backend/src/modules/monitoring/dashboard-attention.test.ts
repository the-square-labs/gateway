import { describe, expect, it } from 'vitest';
import {
  getDashboardAttentionSeverity,
  hasDashboardPinnedDatabaseWarning,
  hasDashboardPinnedDockerWarning,
} from './dashboard-attention.js';

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

  it('ignores unhealthy databases pinned only in the sidebar', () => {
    const databases = [
      { id: 'dashboard-db', healthStatus: 'online' },
      { id: 'sidebar-db', healthStatus: 'offline' },
    ];

    expect(hasDashboardPinnedDatabaseWarning(databases, ['dashboard-db'])).toBe(false);
    expect(hasDashboardPinnedDatabaseWarning(databases, ['sidebar-db'])).toBe(true);
  });

  it('ignores unhealthy Docker resources pinned only in the sidebar', () => {
    const resources = [
      { id: 'dashboard-container', nodeId: 'node-1', kind: 'container', state: 'running' },
      { id: 'sidebar-container', nodeId: 'node-1', kind: 'container', state: 'exited' },
    ];

    expect(
      hasDashboardPinnedDockerWarning(resources, [{ id: 'dashboard-container', nodeId: 'node-1', kind: 'container' }])
    ).toBe(false);
    expect(
      hasDashboardPinnedDockerWarning(resources, [{ id: 'sidebar-container', nodeId: 'node-1', kind: 'container' }])
    ).toBe(true);
  });
});
