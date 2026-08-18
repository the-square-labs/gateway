import { describe, expect, it } from 'vitest';
import { notificationAlertStates, sslCertificates } from '@/db/schema/index.js';
import { NotificationEvaluatorService } from './notification-evaluator.service.js';

const BASE_RULE = {
  id: 'rule-1',
  name: 'Certificate Expiry',
  enabled: true,
  type: 'threshold',
  category: 'certificate',
  severity: 'warning',
  metric: 'days_until_expiry',
  operator: '<=',
  thresholdValue: 14,
  durationSeconds: 0,
  fireThresholdPercent: 100,
  resolveAfterSeconds: 0,
  resolveThresholdPercent: 100,
  resourceIds: [],
  webhookIds: [],
};

const BASE_EVENT_RULE = {
  id: 'event-rule-1',
  name: 'Node Offline',
  enabled: true,
  type: 'event',
  category: 'node',
  severity: 'critical',
  metric: null,
  operator: null,
  thresholdValue: null,
  durationSeconds: 0,
  fireThresholdPercent: 100,
  resolveAfterSeconds: 0,
  resolveThresholdPercent: 100,
  eventPattern: 'offline',
  resourceIds: [],
  webhookIds: [],
};

function createEvaluator(
  certs: any[],
  thresholdRules = [BASE_RULE],
  eventRules: any[] = [],
  nodesById: Record<string, any> = {},
  proxyHostRows: any[] = []
) {
  const states: any[] = [];
  const db = {
    query: {
      sslCertificates: {
        findMany: async () => certs.filter((cert) => cert.status === 'active'),
      },
      proxyHosts: {
        findMany: async () => proxyHostRows,
      },
    },
    select: () => ({
      from: (table: unknown) => {
        const activeRows = () =>
          table === sslCertificates
            ? certs.filter((cert) => cert.status === 'active')
            : states.filter((state) => state.status === 'firing');
        return {
          where: async () => activeRows(),
          innerJoin: () => ({
            where: async () =>
              table === notificationAlertStates
                ? states
                    .filter((state) => state.status === 'firing')
                    .flatMap((state) => {
                      const rule = eventRules.find((candidate) => candidate.id === state.ruleId);
                      return rule ? [{ state, rule }] : [];
                    })
                : [],
          }),
        };
      },
    }),
  };

  const evaluator = new NotificationEvaluatorService(
    db as any,
    {
      getEnabledThresholdRules: async () => thresholdRules,
      getEnabledEventRules: async () => eventRules,
    } as any,
    { getRawByIds: async () => [] } as any,
    { dispatch: async () => undefined } as any,
    null,
    { getNode: (nodeId: string) => nodesById[nodeId] ?? null } as any
  );

  (evaluator as any).recordProbeOutcome = async () => undefined;
  (evaluator as any).getActiveAlertState = async (ruleId: string, resourceType: string, resourceId: string) =>
    states.find(
      (state) =>
        state.ruleId === ruleId &&
        state.resourceType === resourceType &&
        state.resourceId === resourceId &&
        state.status === 'firing'
    ) ?? null;
  (evaluator as any).fireAlert = async (
    rule: any,
    resourceType: string,
    resourceId: string,
    resourceName: string,
    context: Record<string, unknown>
  ) => {
    states.push({
      id: `state-${states.length + 1}`,
      ruleId: rule.id,
      resourceType,
      resourceId,
      resourceName,
      status: 'firing',
      firedAt: new Date('2026-04-01T00:00:00Z'),
      context,
    });
  };
  (evaluator as any).resolveAlert = async (
    stateId: string,
    _rule: any,
    _resourceType: string,
    _resourceId: string,
    resourceName: string,
    context: Record<string, unknown>
  ) => {
    const state = states.find((candidate) => candidate.id === stateId);
    if (state) {
      state.status = 'resolved';
      state.resourceName = resourceName;
      state.context = context;
    }
  };

  return { evaluator, states };
}

describe('NotificationEvaluatorService certificate expiry evaluation', () => {
  it('fires when an active SSL certificate is within the configured threshold', async () => {
    const { evaluator, states } = createEvaluator([
      {
        id: 'cert-1',
        name: 'example.com',
        domainNames: ['example.com'],
        status: 'active',
        notAfter: new Date('2026-04-10T00:00:00Z'),
      },
    ]);

    await evaluator.evaluateCertificateExpiry(new Date('2026-04-01T00:00:00Z'));

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      resourceType: 'certificate',
      resourceId: 'cert-1',
      status: 'firing',
      context: {
        certificate: {
          days_until_expiry: 9,
          expiry_date: '2026-04-10T00:00:00.000Z',
        },
        metric: {
          name: 'days_until_expiry',
          value: 9,
          threshold: 14,
          operator: '<=',
        },
      },
    });
  });

  it('resolves when certificate expiry moves outside the threshold', async () => {
    const cert = {
      id: 'cert-1',
      name: 'example.com',
      domainNames: ['example.com'],
      status: 'active',
      notAfter: new Date('2026-04-10T00:00:00Z'),
    };
    const { evaluator, states } = createEvaluator([cert]);

    await evaluator.evaluateCertificateExpiry(new Date('2026-04-01T00:00:00Z'));
    cert.notAfter = new Date('2026-05-15T00:00:00Z');
    await evaluator.evaluateCertificateExpiry(new Date('2026-04-01T00:00:00Z'));

    expect(states).toHaveLength(1);
    expect(states[0].status).toBe('resolved');
    expect(states[0].context).toMatchObject({
      certificate: {
        days_until_expiry: 44,
      },
      metric: {
        value: 44,
        threshold: 14,
        operator: '<=',
      },
    });
  });

  it('resolves stale firing state when the certificate is no longer active', async () => {
    const cert = {
      id: 'cert-1',
      name: 'example.com',
      domainNames: ['example.com'],
      status: 'active',
      notAfter: new Date('2026-04-10T00:00:00Z'),
    };
    const { evaluator, states } = createEvaluator([cert]);

    await evaluator.evaluateCertificateExpiry(new Date('2026-04-01T00:00:00Z'));
    cert.status = 'error';
    await evaluator.evaluateCertificateExpiry(new Date('2026-04-01T00:00:00Z'));

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      status: 'resolved',
      context: {
        resolution: {
          reason: 'certificate_inactive_or_deleted',
        },
      },
    });
  });
});

describe('NotificationEvaluatorService stateful event evaluation', () => {
  it('fires, deduplicates, and resolves a Project-scoped Pages quota event', async () => {
    const pagesRule = {
      ...BASE_EVENT_RULE,
      id: 'pages-quota-rule',
      name: 'Pages quota blocked',
      category: 'pages',
      severity: 'warning',
      eventPattern: 'quota.blocked',
      resolveAfterSeconds: 0,
      resourceIds: ['page-project-1'],
    };
    const { evaluator, states } = createEvaluator([], [], [pagesRule]);
    const blocked = {
      action: 'quota.blocked',
      projectId: 'page-project-1',
      quotaUsedBytes: 1200,
      quotaLimitBytes: 1000,
      failureCode: 'PAGES_QUOTA_BLOCKED',
    };

    await (evaluator as any).handleBusEvent('pages.project.changed', blocked);
    await (evaluator as any).handleBusEvent('pages.project.changed', blocked);

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      resourceType: 'page_project',
      resourceId: 'page-project-1',
      status: 'firing',
      context: {
        event: { name: 'quota.blocked' },
        state: { current: 'quota.blocked' },
        failure: { code: 'PAGES_QUOTA_BLOCKED' },
      },
    });

    await (evaluator as any).handleBusEvent('pages.project.changed', {
      ...blocked,
      action: 'quota.resolved',
      failureCode: null,
    });
    expect(states[0].status).toBe('resolved');
  });

  it('fires a stateful event rule when the observed state matches', async () => {
    const { evaluator, states } = createEvaluator([], [], [BASE_EVENT_RULE]);

    await evaluator.observeStatefulEvent(
      'node',
      'offline',
      { type: 'node', id: 'node-1', name: 'worker-1' },
      { hostname: 'worker-1' }
    );

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      ruleId: 'event-rule-1',
      resourceType: 'node',
      resourceId: 'node-1',
      status: 'firing',
      context: {
        event: {
          name: 'offline',
        },
        state: {
          current: 'offline',
        },
        node: {
          name: 'worker-1',
        },
      },
    });
  });

  it('resolves a stateful event rule when the observed state clears', async () => {
    const { evaluator, states } = createEvaluator([], [], [BASE_EVENT_RULE]);

    await evaluator.observeStatefulEvent('node', 'offline', { type: 'node', id: 'node-1', name: 'worker-1' });
    await evaluator.observeStatefulEvent('node', 'online', { type: 'node', id: 'node-1', name: 'worker-1' });

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      status: 'resolved',
      context: {
        event: {
          name: 'offline',
        },
        state: {
          current: 'online',
        },
      },
    });
  });

  it('only evaluates the observed stateful event patterns when provided', async () => {
    const stoppedRule = {
      ...BASE_EVENT_RULE,
      id: 'event-rule-stopped',
      name: 'Container Stopped',
      category: 'container',
      eventPattern: 'stopped',
    };
    const exitedRule = {
      ...BASE_EVENT_RULE,
      id: 'event-rule-exited',
      name: 'Container Exited',
      category: 'container',
      eventPattern: 'exited',
    };
    const { evaluator, states } = createEvaluator([], [], [stoppedRule, exitedRule]);
    const resource = { type: 'container', id: 'nginx', name: 'nginx' };
    const context = { nodeId: 'node-1', containerId: 'container-abc123' };

    await evaluator.observeStatefulEvent('container', 'stopped', resource, context, ['stopped']);
    await evaluator.observeStatefulEvent('container', 'exited', resource, context, ['exited']);

    expect(states).toHaveLength(2);
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'event-rule-stopped', status: 'firing' }),
        expect.objectContaining({
          ruleId: 'event-rule-exited',
          status: 'firing',
          context: expect.objectContaining({ resourceId: 'container-abc123' }),
        }),
      ])
    );

    await evaluator.observeStatefulEvent('container', 'started', resource, context, ['stopped', 'exited']);

    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'event-rule-stopped',
          status: 'resolved',
          context: expect.objectContaining({ state: { current: 'started' } }),
        }),
        expect.objectContaining({
          ruleId: 'event-rule-exited',
          status: 'resolved',
          context: expect.objectContaining({ state: { current: 'started' } }),
        }),
      ])
    );
  });

  it('reconciles maintenance rules created while a proxy host is already maintained', async () => {
    const rule = {
      ...BASE_EVENT_RULE,
      id: 'maintenance-rule',
      name: 'Maintenance active',
      category: 'proxy',
      eventPattern: 'maintenance.active',
      severity: 'warning',
    };
    const hosts = [
      {
        id: 'proxy-1',
        domainNames: ['example.com'],
        enabled: true,
        isSystem: false,
        maintenanceEnabled: true,
      },
    ];
    const { evaluator, states } = createEvaluator([], [], [rule], {}, hosts);

    await evaluator.reconcileProxyMaintenance();
    expect(states).toMatchObject([
      {
        ruleId: 'maintenance-rule',
        resourceType: 'proxy',
        resourceId: 'proxy-1',
        status: 'firing',
      },
    ]);

    hosts[0]!.maintenanceEnabled = false;
    await evaluator.reconcileProxyMaintenance();
    expect(states[0]?.status).toBe('resolved');
  });
});

describe('NotificationEvaluatorService node health evaluation', () => {
  it('uses the node name for fired disk alert resource labels', async () => {
    const diskRule = {
      ...BASE_RULE,
      id: 'disk-rule-1',
      name: 'High disk usage',
      category: 'node',
      metric: 'disk',
      operator: '>',
      thresholdValue: 85,
      severity: 'critical',
    };
    const { evaluator, states } = createEvaluator([], [diskRule], [], {
      'node-1': { hostname: 'sharkbot-shared' },
    });

    await evaluator.evaluateHealthReport('node-1', {
      diskMounts: [{ mountPoint: '/', usagePercent: 100 }],
    });

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      resourceType: 'node',
      resourceId: 'node-1:/',
      resourceName: 'sharkbot-shared',
      status: 'firing',
      context: {
        node: {
          id: 'node-1',
          name: 'sharkbot-shared',
        },
        metric: {
          name: 'disk',
          value: 100,
        },
      },
    });
  });

  it('keeps GPU threshold states separate for each physical device', async () => {
    const gpuRule = {
      ...BASE_RULE,
      id: 'gpu-utilization-rule',
      name: 'High GPU utilization',
      category: 'node',
      metric: 'gpu_utilization_percent',
      operator: '>',
      thresholdValue: 90,
      severity: 'warning',
    };
    const { evaluator, states } = createEvaluator([], [gpuRule], [], {
      'node-1': { hostname: 'gpu-worker' },
    });

    await evaluator.evaluateHealthReport('node-1', {
      gpuDevices: [
        { id: 'nvidia:gpu-a', availableMetrics: ['utilization_percent'], utilizationPercent: 95 },
        { id: 'nvidia:gpu-b', availableMetrics: ['utilization_percent'], utilizationPercent: 97 },
      ],
    });

    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceType: 'node',
          resourceId: 'node-1:nvidia:gpu-a',
          resourceName: 'gpu-worker · nvidia:gpu-a',
        }),
        expect.objectContaining({
          resourceType: 'node',
          resourceId: 'node-1:nvidia:gpu-b',
          resourceName: 'gpu-worker · nvidia:gpu-b',
        }),
      ])
    );

    await evaluator.evaluateHealthReport('node-1', {
      gpuDevices: [
        { id: 'nvidia:gpu-a', availableMetrics: ['utilization_percent'], utilizationPercent: 10 },
        { id: 'nvidia:gpu-b', availableMetrics: ['utilization_percent'], utilizationPercent: 97 },
      ],
    });

    expect(states.find((state) => state.resourceId === 'node-1:nvidia:gpu-a')).toMatchObject({ status: 'resolved' });
    expect(states.find((state) => state.resourceId === 'node-1:nvidia:gpu-b')).toMatchObject({ status: 'firing' });
  });

  it('keeps the container name for resolved container metric alerts', async () => {
    const containerRule = {
      ...BASE_RULE,
      id: 'container-rule-1',
      name: 'High container CPU',
      category: 'container',
      metric: 'cpu',
      operator: '>',
      thresholdValue: 85,
      severity: 'warning',
    };
    const { evaluator, states } = createEvaluator([], [containerRule], [], {
      'node-1': { hostname: 'docker-node' },
    });

    await evaluator.evaluateHealthReport('node-1', {
      containerStats: [{ name: 'backend', cpuPercent: 95 }],
    });
    await evaluator.evaluateHealthReport('node-1', {
      containerStats: [{ name: 'backend', cpuPercent: 10 }],
    });

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      resourceType: 'container',
      resourceId: 'node-1:backend',
      resourceName: 'backend',
      status: 'resolved',
    });
  });
});

describe('NotificationEvaluatorService database threshold evaluation', () => {
  it('keeps the database name for resolved database metric alerts', async () => {
    const databaseRule = {
      ...BASE_RULE,
      id: 'database-rule-1',
      name: 'High database latency',
      category: 'database_postgres',
      metric: 'latency_ms',
      operator: '>',
      thresholdValue: 1000,
      severity: 'warning',
    };
    const { evaluator, states } = createEvaluator([], [databaseRule]);

    await evaluator.evaluateDatabaseSnapshot({
      databaseId: 'database-1',
      type: 'postgres',
      name: 'Primary Postgres',
      metrics: { latency_ms: 1500 },
    });
    await evaluator.evaluateDatabaseSnapshot({
      databaseId: 'database-1',
      type: 'postgres',
      name: 'Primary Postgres',
      metrics: { latency_ms: 25 },
    });

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      resourceType: 'database_postgres',
      resourceId: 'database-1',
      resourceName: 'Primary Postgres',
      status: 'resolved',
    });
  });

  it('evaluates ClickHouse metrics against the ClickHouse notification category', async () => {
    const databaseRule = {
      ...BASE_RULE,
      id: 'clickhouse-rule-1',
      name: 'High ClickHouse disk usage',
      category: 'database_clickhouse',
      metric: 'disk_used_pct',
      operator: '>',
      thresholdValue: 90,
      severity: 'critical',
    };
    const { evaluator, states } = createEvaluator([], [databaseRule]);

    await evaluator.evaluateDatabaseSnapshot({
      databaseId: 'clickhouse-1',
      type: 'clickhouse',
      name: 'Analytics ClickHouse',
      metrics: { disk_used_pct: 95 },
    });
    await evaluator.evaluateDatabaseSnapshot({
      databaseId: 'clickhouse-1',
      type: 'clickhouse',
      name: 'Analytics ClickHouse',
      metrics: { disk_used_pct: 40 },
    });

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      resourceType: 'database_clickhouse',
      resourceId: 'clickhouse-1',
      resourceName: 'Analytics ClickHouse',
      status: 'resolved',
    });
  });

  it('fires and resolves ClickHouse low available disk alerts', async () => {
    const databaseRule = {
      ...BASE_RULE,
      id: 'clickhouse-available-disk-rule',
      name: 'Low ClickHouse available disk',
      category: 'database_clickhouse',
      metric: 'disk_available_mb',
      operator: '<',
      thresholdValue: 10_240,
      severity: 'critical',
    };
    const { evaluator, states } = createEvaluator([], [databaseRule]);

    await evaluator.evaluateDatabaseSnapshot({
      databaseId: 'clickhouse-1',
      type: 'clickhouse',
      name: 'Analytics ClickHouse',
      metrics: { disk_available_mb: 5_000 },
    });
    await evaluator.evaluateDatabaseSnapshot({
      databaseId: 'clickhouse-1',
      type: 'clickhouse',
      name: 'Analytics ClickHouse',
      metrics: { disk_available_mb: 20_000 },
    });

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      resourceType: 'database_clickhouse',
      resourceId: 'clickhouse-1',
      resourceName: 'Analytics ClickHouse',
      status: 'resolved',
    });
  });
});

describe('NotificationEvaluatorService ratio window evaluation', () => {
  it('uses a pre-window sample as coverage anchor for jittered polling intervals', async () => {
    const { evaluator } = createEvaluator([]);
    const now = 1_000_000;
    const zrangebyscore = async () => [`${now - 60_002}:1`, `${now - 30_000}:1`, `${now}:1`];
    (evaluator as any).redis = { zrangebyscore };

    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const result = await (evaluator as any).evaluateRatioWindow('rule-1', 'node-1', 60_000, 100, 'breach');

      expect(result).toMatchObject({
        hasCoverage: true,
        sampleCount: 3,
        matchingSamples: 3,
        thresholdMet: true,
      });
    } finally {
      Date.now = originalNow;
    }
  });
});
