import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ALERT_CATEGORIES,
  CATEGORY_MAP,
  EVENT_BUS_MAPPINGS,
  evaluateThreshold,
  extractMetricFromDatabaseSnapshot,
  extractMetricFromHealthReport,
  isPerDeviceNodeMetric,
  SEVERITY_COLOR,
  SEVERITY_EMOJI,
  SEVERITY_ORDER,
  type Severity,
  severityMeetsMinimum,
} from '@/modules/notifications/notification.constants.js';

describe('notification constants characterization', () => {
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

  it('keeps the complete public catalog stable', () => {
    expect(
      hash({
        severityOrder: SEVERITY_ORDER,
        severityEmoji: SEVERITY_EMOJI,
        severityColor: SEVERITY_COLOR,
        categories: ALERT_CATEGORIES,
      })
    ).toBe('66c321f02550d2fce48d0756c1e3813bfdc20c431f175c32a6eb7f428b332e32');
  });

  it('keeps EventBus topic, event, and stateful topology stable', () => {
    const topology = Object.fromEntries(
      Object.entries(EVENT_BUS_MAPPINGS).map(([topic, mappings]) => [
        topic,
        mappings.map((mapping) => ({
          category: mapping.category,
          eventId: mapping.eventId,
          hasDataExtractor: mapping.extractData !== undefined,
          stateful: mapping.stateful
            ? {
                observedPatterns: mapping.stateful.observedPatterns,
              }
            : null,
        })),
      ])
    );

    expect(hash(topology)).toBe('858ae78e576d1e2957b5a10df4767ad3a9517694bec684eacc46e23686b23f8a');
  });

  it('keeps every EventBus mapping function behavior stable across lifecycle payloads', () => {
    const base = {
      id: 'resource-1',
      name: 'Resource One',
      hostname: 'node-1',
      domain: 'app.example.test',
      nodeId: 'node-1',
      projectId: 'project-1',
      projectName: 'Project One',
      sourceBindingId: 'source-1',
      targetName: 'api',
      groupId: 'group-1',
      groupName: 'Operators',
      requireGateway2fa: true,
      deploymentId: 'deployment-1',
      resourceName: 'Resource One',
      containerName: 'container-1',
      databaseId: 'database-1',
      managedDatabaseId: 'managed-database-1',
      bindingId: 'binding-1',
      resourceKind: 'managed_database_binding',
      targetNodeId: 'target-node-1',
      targetType: 'container',
      targetResourceId: 'target-1',
      sourceNodeId: 'source-node-1',
      publicSlug: 'public-slug',
      failureCode: 'failure-code',
      errorCode: 'error-code',
      errorMessage: 'error-message',
      healthStatus: 'offline',
      health_status: 'offline',
      operation: 'deploy',
      operationAction: 'apply',
      trigger: 'manual',
      phase: 'provisioning',
      state: 'failed',
      type: 'postgres',
      action: 'created',
      status: 'online',
    };
    const actions = [
      'created',
      'deleted',
      'renewed',
      'renewal_failed',
      'expired',
      'health.offline',
      'health.degraded',
      'health.online',
      'operation_succeeded',
      'operation_failed',
      'operation_cancelled',
      'revision_activated',
      'ready',
      'failed',
      'publication.failed',
      'quota.blocked',
      'quota.resolved',
      'cleanup.needs_attention',
      'cleanup.healthy',
      'profile.unavailable',
      'profile.healthy',
      'capability.missing',
      'capability.restored',
      'sync-failed',
      'synced',
      'tested',
      'started',
      'stopped',
      'killed',
      'binding.error',
      'binding.ready',
      'binding.deleted',
      'binding.reconciliation_failed',
      'binding.reconciliation_ready',
    ];
    const statuses = [
      'succeeded',
      'failed',
      'cancelled',
      'superseded',
      'ready',
      'online',
      'offline',
      'degraded',
      'needs_attention',
      'healthy',
      'complete',
      'expired_grace',
      'valid_with_warning',
      'expired',
      'invalid',
      'revoked',
      'deactivated',
    ];
    const payloads = [
      base,
      ...actions.map((action) => ({ ...base, action })),
      ...statuses.map((status) => ({ ...base, status })),
      ...['postgres', 'clickhouse', 'redis'].flatMap((type) =>
        ['created', 'ready', 'stopped', 'error', 'deleted'].map((action) => ({ ...base, type, action }))
      ),
      ...['postgres', 'clickhouse', 'redis'].flatMap((type) => [
        { ...base, type, action: 'binding.error', failurePhase: 'provisioning' },
        { ...base, type, action: 'binding.ready', failurePhase: 'provisioning' },
        { ...base, type, action: 'binding.reconciliation_failed', failurePhase: 'reconciliation' },
        { ...base, type, action: 'binding.reconciliation_ready', failurePhase: 'reconciliation' },
      ]),
      { ...base, phase: 'provisioning', state: 'failed' },
      { ...base, phase: 'reconciliation', state: 'failed' },
      { ...base, phase: 'reconciliation', state: 'healthy' },
      { ...base, state: 'critical' },
      { ...base, state: 'recovering' },
      { ...base, state: 'healthy' },
      { ...base, status: 'pressure' },
      { ...base, status: 'exhausted' },
      { ...base, status: 'unavailable' },
    ];
    const behavior = Object.fromEntries(
      Object.entries(EVENT_BUS_MAPPINGS).map(([topic, mappings]) => [
        topic,
        mappings.map((mapping) =>
          payloads.map((payload) => ({
            match: mapping.match(payload),
            resource: mapping.extractResource(payload),
            data: mapping.extractData?.(payload) ?? null,
            state: mapping.stateful?.currentState(payload) ?? null,
          }))
        ),
      ])
    );

    expect(hash(behavior)).toBe('eb9ff09088637156779e1e8c61c305c3d800e8d02687d82963f78100e8360545');
  });

  it('keeps category, metric, event, and template-variable identities unique', () => {
    expect(new Set(ALERT_CATEGORIES.map((category) => category.id)).size).toBe(ALERT_CATEGORIES.length);

    for (const category of ALERT_CATEGORIES) {
      expect(CATEGORY_MAP.get(category.id)).toBe(category);
      expect(new Set(category.metrics.map((metric) => metric.id)).size).toBe(category.metrics.length);
      expect(new Set(category.events.map((event) => event.id)).size).toBe(category.events.length);
      expect(new Set(category.variables.map((variable) => variable.name)).size).toBe(category.variables.length);
    }
  });

  it('preserves the full severity ordering truth table', () => {
    const severities: Severity[] = ['info', 'warning', 'critical'];
    const truthTable = Object.fromEntries(
      severities.flatMap((actual) =>
        severities.map((minimum) => [`${actual}>=${minimum}`, severityMeetsMinimum(actual, minimum)])
      )
    );

    expect(truthTable).toEqual({
      'info>=info': true,
      'info>=warning': false,
      'info>=critical': false,
      'warning>=info': true,
      'warning>=warning': true,
      'warning>=critical': false,
      'critical>=info': true,
      'critical>=warning': true,
      'critical>=critical': true,
    });
  });

  it('preserves threshold operator boundaries and fail-closed unknown operators', () => {
    expect([
      evaluateThreshold(11, '>', 10),
      evaluateThreshold(10, '>', 10),
      evaluateThreshold(10, '>=', 10),
      evaluateThreshold(9, '>=', 10),
      evaluateThreshold(9, '<', 10),
      evaluateThreshold(10, '<', 10),
      evaluateThreshold(10, '<=', 10),
      evaluateThreshold(11, '<=', 10),
      evaluateThreshold(10, '=', 10),
    ]).toEqual([true, false, true, false, true, false, true, false, false]);
  });

  it('preserves node and container metric extraction across wire naming variants and targets', () => {
    expect(extractMetricFromHealthReport('node', 'cpu', { cpuPercent: 41 })).toEqual({
      values: [{ resourceId: 'system', value: 41 }],
    });
    expect(extractMetricFromHealthReport('node', 'cpu', { cpu_percent: 42 })).toEqual({
      values: [{ resourceId: 'system', value: 42 }],
    });
    expect(
      extractMetricFromHealthReport('node', 'memory', {
        system_memory_total_bytes: 400,
        system_memory_used_bytes: 100,
      })
    ).toEqual({ values: [{ resourceId: 'system', value: 25 }] });
    expect(
      extractMetricFromHealthReport(
        'node',
        'disk',
        {
          diskMounts: [
            { mountPoint: '/', usagePercent: 75 },
            { mountPoint: '/data', usagePercent: 60 },
          ],
        },
        '/data'
      )
    ).toEqual({ values: [{ resourceId: '/data', value: 60 }] });
    expect(extractMetricFromHealthReport('node', 'disk', { disk_free_bytes: 25, disk_total_bytes: 100 }, '/')).toEqual({
      values: [{ resourceId: '/', value: 75 }],
    });
    expect(extractMetricFromHealthReport('node', 'disk', { disk_free_bytes: 25, disk_total_bytes: 100 }, '/data')).toBe(
      null
    );

    const containers = {
      container_stats: [
        {
          name: 'api',
          cpu_percent: 12.5,
          memory_usage_bytes: 50,
          memory_limit_bytes: 200,
          metrics_available: true,
        },
        {
          name: 'hidden',
          cpu_percent: 99,
          memory_usage_bytes: 99,
          memory_limit_bytes: 100,
          metrics_available: false,
        },
      ],
    };
    expect(extractMetricFromHealthReport('container', 'cpu', containers)).toEqual({
      values: [{ resourceId: 'api', value: 12.5 }],
    });
    expect(extractMetricFromHealthReport('container', 'memory', containers)).toEqual({
      values: [{ resourceId: 'api', value: 25 }],
    });
  });

  it('preserves capability-aware per-device GPU metric extraction', () => {
    const health = {
      gpuDevices: [
        {
          id: 'gpu-0',
          availableMetrics: [
            'utilization_percent',
            'memory_total_bytes',
            'memory_used_bytes',
            'temperature_celsius',
            'power_watts',
            'power_limit_watts',
            'throttled',
            'health',
            'ecc_corrected_errors',
            'ecc_uncorrected_errors',
          ],
          utilizationPercent: 80,
          memoryTotalBytes: 1000,
          memoryUsedBytes: 250,
          temperatureCelsius: 70,
          powerWatts: 150,
          powerLimitWatts: 300,
          throttled: true,
          health: 'degraded',
          eccCorrectedErrors: 3,
          eccUncorrectedErrors: 1,
        },
        {
          id: 'gpu-1',
          availableMetrics: [],
          utilizationPercent: 100,
        },
      ],
    };
    const expected = new Map([
      ['gpu_utilization_percent', 80],
      ['gpu_memory_used_percent', 25],
      ['gpu_temperature_celsius', 70],
      ['gpu_power_percent_of_limit', 50],
      ['gpu_throttled', 1],
      ['gpu_health_degraded', 1],
      ['gpu_ecc_corrected_errors', 3],
      ['gpu_ecc_uncorrected_errors', 1],
    ]);

    for (const [metric, value] of expected) {
      expect(isPerDeviceNodeMetric(metric)).toBe(true);
      expect(extractMetricFromHealthReport('node', metric, health, 'gpu-0')).toEqual({
        values: [{ resourceId: 'gpu-0', value }],
      });
      expect(extractMetricFromHealthReport('node', metric, health, 'gpu-1')).toBe(null);
    }
    expect(isPerDeviceNodeMetric('cpu')).toBe(false);
  });

  it('preserves database metric category filtering and null handling', () => {
    const snapshot = {
      databaseId: 'database-1',
      metrics: {
        active_connections: 7,
        unavailable: null,
        invalid: Number.NaN,
      },
    };

    for (const category of ['database_postgres', 'database_clickhouse', 'database_redis']) {
      expect(extractMetricFromDatabaseSnapshot(category, 'active_connections', snapshot)).toEqual({
        values: [{ resourceId: 'database-1', value: 7 }],
      });
      expect(extractMetricFromDatabaseSnapshot(category, 'unavailable', snapshot)).toBe(null);
      expect(extractMetricFromDatabaseSnapshot(category, 'invalid', snapshot)).toBe(null);
    }
    expect(extractMetricFromDatabaseSnapshot('node', 'active_connections', snapshot)).toBe(null);
  });
});
