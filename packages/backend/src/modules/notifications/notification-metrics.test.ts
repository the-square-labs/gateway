import { describe, expect, it } from 'vitest';
import { extractMetricFromHealthReport } from './notification-metrics.js';

describe('container log size metric', () => {
  it('reports each running container log size in megabytes', () => {
    const report = {
      containerStats: [
        {
          name: 'api',
          state: 'running',
          logBytes: 3 * 1024 * 1024 * 1024,
          logBytesAvailable: true,
          metricsAvailable: true,
        },
        {
          name: 'worker',
          state: 'running',
          logBytes: 50 * 1024 * 1024,
          logBytesAvailable: true,
          metricsAvailable: true,
        },
        { name: 'stopped', state: 'exited', logBytes: 0, metricsAvailable: false },
      ],
    };

    expect(extractMetricFromHealthReport('container', 'log_size', report)).toEqual({
      values: [
        { resourceId: 'api', value: 3072 },
        { resourceId: 'worker', value: 50 },
      ],
    });
  });

  it('leaves out containers whose log size is unknown', () => {
    const report = {
      containerStats: [
        { name: 'old-daemon', state: 'running', metricsAvailable: true },
        { name: 'journald', state: 'running', logBytes: 0, logBytesAvailable: false, metricsAvailable: true },
      ],
    };

    expect(extractMetricFromHealthReport('container', 'log_size', report)).toEqual({ values: [] });
  });
});
