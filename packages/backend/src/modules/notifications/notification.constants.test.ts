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

    expect(category?.events).toContainEqual({ id: 'mfa.required', label: 'Group MFA Required', defaultSeverity: 'warning' });
    expect(mapping.match(payload)).toBe(true);
    expect(mapping.extractResource(payload)).toEqual({ type: 'permission_group', id: 'group-1', name: 'Operators' });
    expect(mapping.extractData).toBeUndefined();
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
});
