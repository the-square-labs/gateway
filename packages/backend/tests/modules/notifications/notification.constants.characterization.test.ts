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
    ).toBe('6a5d729937b24afaac984d83e097c1bd66fcdc84a7f560a18dd0fd1103891081');
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

    expect(hash(topology)).toBe('7e032ee5260fbc9a45e70d0afa202eaa7e8617cfd7b38ef9f4d736ce7d5c0f63');
  });

  it('covers the intended hosting catalog and EventBus mapping additions', () => {
    expect(ALERT_CATEGORIES.slice(0, 2).map(({ id }) => id)).toEqual(['hosting_vm', 'hosting_account']);
    expect(ALERT_CATEGORIES.find(({ id }) => id === 'hosting_vm')).toMatchObject({
      metrics: [],
      events: expect.arrayContaining([
        expect.objectContaining({ id: 'operation.failed', defaultSeverity: 'critical' }),
        expect.objectContaining({ id: 'operation.ready', defaultSeverity: 'info' }),
        expect.objectContaining({ id: 'operation.unknown', defaultSeverity: 'warning' }),
        expect.objectContaining({ id: 'firewall.failed', defaultSeverity: 'critical', supportsThreshold: true }),
      ]),
    });
    expect(ALERT_CATEGORIES.find(({ id }) => id === 'hosting_account')).toMatchObject({
      metrics: expect.arrayContaining([
        expect.objectContaining({ id: 'balance' }),
        expect.objectContaining({ id: 'monthly_expenses' }),
      ]),
      events: [expect.objectContaining({ id: 'sync.failed', defaultSeverity: 'warning', supportsThreshold: true })],
    });

    const vmMapping = EVENT_BUS_MAPPINGS['hosting.vm.observed']?.[0];
    const vmPayload = {
      resourceId: 'vm-1',
      name: 'Worker VM',
      powerState: 'running',
      provider: 'digitalocean',
      connectorId: 'connector-1',
      remoteId: 'droplet-1',
    };
    expect(vmMapping?.match(vmPayload)).toBe(true);
    expect(vmMapping?.extractResource(vmPayload)).toEqual({ type: 'hosting_vm', id: 'vm-1', name: 'Worker VM' });
    expect(vmMapping?.stateful?.currentState(vmPayload)).toBe('power.running');

    const accountMapping = EVENT_BUS_MAPPINGS['hosting.account.observed']?.[0];
    expect(accountMapping?.match({ connectorId: 'connector-1', syncStatus: 'error' })).toBe(true);
    expect(accountMapping?.stateful?.currentState({ syncStatus: 'success' })).toBe('sync.healthy');

    expect(EVENT_BUS_MAPPINGS['hosting.operation.changed']?.map(({ eventId }) => eventId)).toEqual([
      'operation.failed',
      'operation.ready',
      'operation.unknown',
    ]);
    const operationMapping = EVENT_BUS_MAPPINGS['hosting.operation.changed']?.[0];
    expect(operationMapping?.match({ phase: 'failed', action: 'create' })).toBe(true);
    expect(operationMapping?.match({ phase: 'failed', action: 'topup' })).toBe(false);

    const firewallMapping = EVENT_BUS_MAPPINGS['hosting.firewall.observed']?.[0];
    expect(firewallMapping?.match({ resourceId: 'vm-1', status: 'failed' })).toBe(true);
    expect(firewallMapping?.stateful?.currentState({ status: 'failed' })).toBe('firewall.failed');
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

    expect(hash(behavior)).toBe('219357a1618e79557da70197a65ca0d6a563c077bdfe3f14b3ffea59c80627b6');
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
