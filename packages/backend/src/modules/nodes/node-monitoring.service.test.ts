import { describe, expect, it } from 'vitest';
import { compactMonitoringHistorySnapshot } from './node-monitoring.service.js';

describe('compactMonitoringHistorySnapshot', () => {
  it('keeps the nginx service problem so the Monitoring tab can show it', () => {
    const problem = 'nginx is not running and its pid directory /run/nginx is gone; start nginx as root';
    const snapshot = compactMonitoringHistorySnapshot({
      timestamp: '2026-10-09T10:00:00.000Z',
      health: { nginxRunning: false, configValid: true, nginxServiceProblem: problem },
      stats: {},
    });
    expect(snapshot.health.nginxServiceProblem).toBe(problem);
  });

  it('omits the field when the node reports no problem', () => {
    const snapshot = compactMonitoringHistorySnapshot({
      timestamp: '2026-10-09T10:00:00.000Z',
      health: { nginxRunning: true, configValid: true },
      stats: {},
    });
    expect('nginxServiceProblem' in snapshot.health).toBe(false);
  });
});
