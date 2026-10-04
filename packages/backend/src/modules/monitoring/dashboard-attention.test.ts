import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  dashboardPinnedDatabaseWarningIds,
  dashboardPinnedDockerWarningKeys,
  dockerResourceKey,
  effectiveNodeStatus,
  getDashboardAttentionSeverity,
  hasNodeCapacityWarning,
  lowInferenceUsageWindows,
  nodeCapacityWarnings,
  nodeHealthAttentionIds,
  proxyHealthAttentionIds,
} from './dashboard-attention.js';

/**
 * The sidebar Dashboard dot is raised here; the Dashboard draws its cards, badges and notices with
 * packages/frontend/src/lib/dashboard-attention.ts and the shared status tones. Both run over the same
 * cases, so a node, route, pinned resource or quota window cannot light the dot without the Dashboard
 * showing it as a warning, or the other way round.
 */
type FrontendAttention = {
  nodeCapacityWarnings: typeof nodeCapacityWarnings;
  effectiveNodeStatus: (node: Parameters<typeof effectiveNodeStatus>[0], now?: number) => string;
  lowInferenceUsageWindows: typeof lowInferenceUsageWindows;
  dockerResourceKey: typeof dockerResourceKey;
};
type FrontendTones = {
  nodeStatusTone: (status: string) => string;
  proxyHealthTone: (status: string) => string;
  databaseHealthTone: (status: string) => string;
};

const FRONTEND_SRC = join(process.cwd(), '../frontend/src');
let frontend: FrontendAttention;
let tones: FrontendTones;

beforeAll(async () => {
  frontend = await import(join(FRONTEND_SRC, 'lib/dashboard-attention.ts'));
  tones = await import(join(FRONTEND_SRC, 'components/common/resource-status.ts'));
});

const isWarningTone = (tone: string) => tone === 'warning' || tone === 'destructive';
const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const healthReport = (overrides: Record<string, unknown>) => ({
  cpuPercent: 10,
  systemMemoryTotalBytes: 1000,
  systemMemoryUsedBytes: 100,
  diskMounts: [{ mountPoint: '/', usagePercent: 10 }],
  ...overrides,
});

const CAPACITY_CASES: Array<[string, Record<string, unknown> | null, boolean]> = [
  ['no report', null, false],
  ['all low', healthReport({}), false],
  // The card shows 80% for 79.6, but neither the dot nor the warning style fires below the threshold.
  ['cpu just below', healthReport({ cpuPercent: 79.6 }), false],
  ['cpu at threshold', healthReport({ cpuPercent: 80 }), true],
  ['memory below', healthReport({ systemMemoryUsedBytes: 799 }), false],
  ['memory at threshold', healthReport({ systemMemoryUsedBytes: 800 }), true],
  ['memory without total', healthReport({ systemMemoryTotalBytes: 0, systemMemoryUsedBytes: 900 }), false],
  ['root disk at threshold', healthReport({ diskMounts: [{ mountPoint: '/', usagePercent: 80 }] }), true],
  [
    'only a data mount is full',
    healthReport({
      diskMounts: [
        { mountPoint: '/', usagePercent: 40 },
        { mountPoint: '/data', usagePercent: 99 },
      ],
    }),
    false,
  ],
  ['no root mount', healthReport({ diskMounts: [] }), false],
];

describe('dashboard attention parity with the Dashboard', () => {
  it.each(CAPACITY_CASES)('node capacity: %s', (_name, report, expected) => {
    expect(hasNodeCapacityWarning({ lastHealthReport: report })).toBe(expected);
    expect(frontend.nodeCapacityWarnings(report)).toEqual(nodeCapacityWarnings(report));
  });

  const NODE_CASES: Array<[string, { status: string; healthHistory?: Array<{ ts: string; status: string }> }]> = [
    ['online', { status: 'online' }],
    ['online, clean history', { status: 'online', healthHistory: [{ ts: minutesAgo(1), status: 'online' }] }],
    ['online, flapped 4 min ago', { status: 'online', healthHistory: [{ ts: minutesAgo(4), status: 'offline' }] }],
    ['online, degraded 2 min ago', { status: 'online', healthHistory: [{ ts: minutesAgo(2), status: 'degraded' }] }],
    ['online, flapped 6 min ago', { status: 'online', healthHistory: [{ ts: minutesAgo(6), status: 'offline' }] }],
    ['offline', { status: 'offline' }],
    ['error', { status: 'error' }],
    ['degraded', { status: 'degraded' }],
    ['pending', { status: 'pending' }],
  ];

  it.each(NODE_CASES)('node health: %s', (_name, node) => {
    const shown = frontend.effectiveNodeStatus(node, NOW);
    expect(shown).toBe(effectiveNodeStatus(node, NOW));
    const raised = nodeHealthAttentionIds([{ id: 'n1', ...node }], NOW).length > 0;
    expect(raised).toBe(isWarningTone(tones.nodeStatusTone(shown)));
  });

  it.each(['online', 'offline', 'degraded', 'recovering', 'unknown', 'disabled'])('route health: %s', (status) => {
    const tone = isWarningTone(tones.proxyHealthTone(status));
    expect(proxyHealthAttentionIds([{ id: 'r1', healthStatus: status }], []).length > 0).toBe(tone);
    // A dashboard-pinned route shows its effective status (a recent flap reads as recovering).
    expect(
      proxyHealthAttentionIds([], [{ id: 'r1', healthStatus: 'online', effectiveHealthStatus: status }]).length > 0
    ).toBe(tone);
  });

  it.each(['online', 'offline', 'degraded', 'unknown'])('pinned database: %s', (status) => {
    const tone = isWarningTone(tones.databaseHealthTone(status));
    expect(dashboardPinnedDatabaseWarningIds([{ id: 'd1', healthStatus: status }], ['d1']).length > 0).toBe(tone);
    expect(dashboardPinnedDatabaseWarningIds([{ id: 'd1', healthStatus: status }], [])).toEqual([]);
  });

  it('names pinned Docker resources by the key the Dashboard looks up', () => {
    const resource = { kind: 'deployment', nodeId: 'node-1', id: 'web' };
    expect(frontend.dockerResourceKey(resource)).toBe(dockerResourceKey(resource));
    expect(dashboardPinnedDockerWarningKeys([{ ...resource, state: 'exited' }], [resource])).toEqual([
      'deployment:node-1:web',
    ]);
    expect(dashboardPinnedDockerWarningKeys([{ ...resource, state: 'running' }], [resource])).toEqual([]);
  });

  const usageWindow = (percentage: number, extra: Record<string, unknown> = {}) => ({
    configured: true,
    active: true,
    percentage,
    ...extra,
  });
  const usage = (overrides: Record<string, unknown> = {}) => ({
    enabled: true,
    api: usageWindow(10),
    subscription: { '5h': usageWindow(10), '7d': usageWindow(10), '30d': usageWindow(10) },
    ...overrides,
  });
  const INFERENCE_CASES: Array<[string, ReturnType<typeof usage> | null, string[]]> = [
    ['no usage', null, []],
    ['plenty left', usage(), []],
    ['api at 80%', usage({ api: usageWindow(80) }), []],
    ['api at 81%', usage({ api: usageWindow(81) }), ['api']],
    [
      'weekly exhausted',
      usage({ subscription: { '5h': usageWindow(0), '7d': usageWindow(100), '30d': usageWindow(0) } }),
      ['7d'],
    ],
    [
      'lazy window not started',
      usage({
        subscription: { '5h': usageWindow(100, { active: false }), '7d': usageWindow(0), '30d': usageWindow(0) },
      }),
      [],
    ],
    ['not configured', usage({ api: usageWindow(100, { configured: false }) }), []],
    ['budgets disabled', usage({ enabled: false, api: usageWindow(100) }), []],
  ];

  it.each(INFERENCE_CASES)('inference quota: %s', (_name, value, expected) => {
    expect(lowInferenceUsageWindows(value)).toEqual(expected);
    expect(frontend.lowInferenceUsageWindows(value)).toEqual(expected);
  });
});

describe('getDashboardAttentionSeverity', () => {
  it('takes the most severe notice', () => {
    expect(getDashboardAttentionSeverity([])).toBeNull();
    expect(getDashboardAttentionSeverity([{ severity: 'info' }])).toBe('info');
    expect(getDashboardAttentionSeverity([{ severity: 'info' }, { severity: 'warning' }])).toBe('warning');
    expect(getDashboardAttentionSeverity([{ severity: 'warning' }, { severity: 'critical' }])).toBe('critical');
  });
});
