import { describe, expect, it } from 'vitest';
import {
  ALERT_CATEGORIES,
  EVENT_BUS_MAPPINGS,
  evaluateWindowRatio,
  eventSupportsThreshold,
  extractMetricFromHealthReport,
} from './notification.constants.js';

describe('evaluateWindowRatio', () => {
  it('requires full window coverage before threshold can pass', () => {
    const now = 1_000_000;
    const result = evaluateWindowRatio(
      [
        { timestamp: now - 40_000, breached: true },
        { timestamp: now - 20_000, breached: true },
        { timestamp: now, breached: true },
      ],
      'breach',
      100,
      60_000,
      now
    );

    expect(result.hasCoverage).toBe(false);
    expect(result.thresholdMet).toBe(false);
  });

  it('fires only when breach ratio meets the configured threshold', () => {
    const now = 1_000_000;
    const result = evaluateWindowRatio(
      [
        { timestamp: now - 60_000, breached: true },
        { timestamp: now - 40_000, breached: true },
        { timestamp: now - 20_000, breached: false },
        { timestamp: now, breached: true },
      ],
      'breach',
      75,
      60_000,
      now
    );

    expect(result.hasCoverage).toBe(true);
    expect(result.sampleCount).toBe(4);
    expect(result.matchingSamples).toBe(3);
    expect(result.ratioPercent).toBe(75);
    expect(result.thresholdMet).toBe(true);
  });

  it('does not fire when breach ratio is below threshold', () => {
    const now = 1_000_000;
    const result = evaluateWindowRatio(
      [
        { timestamp: now - 60_000, breached: true },
        { timestamp: now - 40_000, breached: false },
        { timestamp: now - 20_000, breached: false },
        { timestamp: now, breached: true },
      ],
      'breach',
      75,
      60_000,
      now
    );

    expect(result.hasCoverage).toBe(true);
    expect(result.ratioPercent).toBe(50);
    expect(result.thresholdMet).toBe(false);
  });

  it('evaluates clear ratio symmetrically for resolve windows', () => {
    const now = 1_000_000;
    const result = evaluateWindowRatio(
      [
        { timestamp: now - 60_000, breached: false },
        { timestamp: now - 40_000, breached: false },
        { timestamp: now - 20_000, breached: true },
        { timestamp: now, breached: false },
      ],
      'clear',
      75,
      60_000,
      now
    );

    expect(result.hasCoverage).toBe(true);
    expect(result.matchingSamples).toBe(3);
    expect(result.ratioPercent).toBe(75);
    expect(result.thresholdMet).toBe(true);
  });

  it('marks only stateful events as threshold-capable', () => {
    expect(eventSupportsThreshold('node', 'offline')).toBe(true);
    expect(eventSupportsThreshold('proxy', 'health.degraded')).toBe(true);
    expect(eventSupportsThreshold('proxy', 'maintenance.active')).toBe(true);
    expect(eventSupportsThreshold('database_postgres', 'health.online')).toBe(true);
    expect(eventSupportsThreshold('database_clickhouse', 'health.online')).toBe(true);
    expect(eventSupportsThreshold('container', 'stopped')).toBe(true);
    expect(eventSupportsThreshold('container', 'exited')).toBe(true);
    expect(eventSupportsThreshold('container', 'health.offline')).toBe(true);
    expect(eventSupportsThreshold('container', 'health.online')).toBe(true);
    expect(eventSupportsThreshold('container', 'started')).toBe(false);
    expect(eventSupportsThreshold('certificate', 'issued')).toBe(false);
  });

  it('defines certificate days-until-expiry as an immediate threshold metric', () => {
    const certificateCategory = ALERT_CATEGORIES.find((category) => category.id === 'certificate');
    const metric = certificateCategory?.metrics.find((m) => m.id === 'days_until_expiry');

    expect(metric).toMatchObject({
      label: 'Days Until Expiry',
      unit: 'days',
      defaultOperator: '<=',
      defaultValue: 14,
      defaultDurationSeconds: 0,
      defaultResolveAfterSeconds: 0,
    });
  });

  it('defines ClickHouse available disk as a native low-space threshold', () => {
    const clickHouseCategory = ALERT_CATEGORIES.find((category) => category.id === 'database_clickhouse');
    const metric = clickHouseCategory?.metrics.find((item) => item.id === 'disk_available_mb');

    expect(metric).toMatchObject({
      label: 'Disk Available (MB)',
      unit: 'MB',
      defaultOperator: '<',
      defaultValue: 10_240,
    });
  });

  it('defines capability-aware GPU node metrics without auto-creating alert rules', () => {
    const nodeCategory = ALERT_CATEGORIES.find((category) => category.id === 'node');

    expect(nodeCategory?.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'gpu_utilization_percent', defaultValue: 90 }),
        expect.objectContaining({ id: 'gpu_memory_used_percent', defaultValue: 90 }),
        expect.objectContaining({ id: 'gpu_power_percent_of_limit', defaultValue: 95 }),
        expect.objectContaining({ id: 'gpu_throttled', defaultOperator: '>=', defaultValue: 1 }),
      ])
    );
  });

  it('maps managed database lifecycle events without forwarding credentials or errors', () => {
    const mapping = EVENT_BUS_MAPPINGS['database.changed'].find(
      (candidate) => candidate.category === 'database_postgres' && candidate.eventId === 'error'
    );
    const payload = {
      managedDatabaseId: 'managed-db-1',
      type: 'postgres',
      action: 'error',
      status: 'error',
      name: 'orders',
      error: 'password=should-not-leak',
      connectionUri: 'postgres://user:secret@example.test/orders',
    };

    expect(mapping?.match(payload)).toBe(true);
    expect(mapping?.extractResource(payload)).toEqual({ type: 'database', id: 'managed-db-1', name: 'orders' });
    expect(mapping?.extractData?.(payload)).toEqual({ status: 'error' });
  });

  it('exposes group MFA enforcement as a security event without member data', () => {
    const category = ALERT_CATEGORIES.find((candidate) => candidate.id === 'security');
    const mapping = EVENT_BUS_MAPPINGS['group.mfa.required'][0];
    const payload = {
      groupId: 'group-1',
      groupName: 'Operators',
      requireGateway2fa: true,
      memberCount: 42,
    };

    expect(category?.events).toContainEqual({
      id: 'mfa.required',
      label: 'Group MFA Required',
      defaultSeverity: 'warning',
    });
    expect(mapping.match(payload)).toBe(true);
    expect(mapping.extractResource(payload)).toEqual({ type: 'permission_group', id: 'group-1', name: 'Operators' });
    expect(mapping.extractData).toBeUndefined();
  });

  it('projects license grace and downgrade transitions onto the notification bus', () => {
    const mapping = EVENT_BUS_MAPPINGS['system.license.changed'][0];
    const payload = {
      status: 'expired_grace',
      plan: 'business',
      expiresAt: '2026-08-17T12:00:00.000Z',
      graceUntil: '2026-08-20T12:00:00.000Z',
    };

    expect(mapping.stateful?.currentState(payload)).toBe('license.expired_grace');
    expect(mapping.extractResource(payload)).toEqual({
      type: 'gateway',
      id: 'gateway-license',
      name: 'Gateway license',
    });
    expect(mapping.extractData?.(payload)).toEqual({
      plan: 'business',
      expires_at: payload.expiresAt,
      grace_until: payload.graceUntil,
    });
    expect(mapping.stateful?.currentState({ status: 'expired', plan: 'community' })).toBe('license.unavailable');
    expect(mapping.stateful?.currentState({ status: 'valid', plan: 'business' })).toBe('license.healthy');
  });

  it('skips Docker container state-only rows for metric extraction', () => {
    const result = extractMetricFromHealthReport('container', 'cpu', {
      containerStats: [
        { name: 'web', state: 'running', cpuPercent: 0, metricsAvailable: false },
        { name: 'api', state: 'running', cpuPercent: 42, metricsAvailable: true },
      ],
    });

    expect(result).toEqual({ values: [{ resourceId: 'api', value: 42 }] });
  });

  it('extracts GPU metrics only when the daemon explicitly marks them available', () => {
    const healthData = {
      gpuDevices: [
        {
          id: 'nvidia:gpu-a',
          availableMetrics: [
            'utilization_percent',
            'memory_total_bytes',
            'memory_used_bytes',
            'power_watts',
            'power_limit_watts',
            'throttled',
            'health',
          ],
          utilizationPercent: 0,
          memoryTotalBytes: 8_000,
          memoryUsedBytes: 4_000,
          powerWatts: 40,
          powerLimitWatts: 80,
          throttled: false,
          health: 'healthy',
          temperatureCelsius: 0,
        },
        {
          id: 'amd:gpu-b',
          availableMetrics: ['utilization_percent'],
          utilizationPercent: 75,
        },
      ],
    };

    expect(extractMetricFromHealthReport('node', 'gpu_utilization_percent', healthData, 'nvidia:gpu-a')).toEqual({
      values: [{ resourceId: 'nvidia:gpu-a', value: 0 }],
    });
    expect(extractMetricFromHealthReport('node', 'gpu_memory_used_percent', healthData, 'nvidia:gpu-a')).toEqual({
      values: [{ resourceId: 'nvidia:gpu-a', value: 50 }],
    });
    expect(extractMetricFromHealthReport('node', 'gpu_power_percent_of_limit', healthData, 'nvidia:gpu-a')).toEqual({
      values: [{ resourceId: 'nvidia:gpu-a', value: 50 }],
    });
    expect(extractMetricFromHealthReport('node', 'gpu_throttled', healthData, 'nvidia:gpu-a')).toEqual({
      values: [{ resourceId: 'nvidia:gpu-a', value: 0 }],
    });
    expect(extractMetricFromHealthReport('node', 'gpu_health_degraded', healthData, 'nvidia:gpu-a')).toEqual({
      values: [{ resourceId: 'nvidia:gpu-a', value: 0 }],
    });
    expect(extractMetricFromHealthReport('node', 'gpu_temperature_celsius', healthData, 'nvidia:gpu-a')).toBeNull();
    expect(extractMetricFromHealthReport('node', 'gpu_utilization_percent', healthData, 'missing')).toBeNull();
  });
});
