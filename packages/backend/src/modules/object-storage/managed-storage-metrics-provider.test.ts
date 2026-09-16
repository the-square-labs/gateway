import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { ManagedStorageMetricsProvider } from './managed-storage-metrics-provider.js';

function provider(reports: Array<{ id: string; lastHealthReport: { timestamp?: number } | null }>) {
  const where = vi
    .fn()
    .mockResolvedValueOnce([
      { nodeId: 'n1', memberIndex: 0 },
      { nodeId: 'n2', memberIndex: 1 },
    ])
    .mockResolvedValueOnce(reports);
  const db = { select: () => ({ from: () => ({ where }) }) } as unknown as DrizzleClient;
  return new ManagedStorageMetricsProvider(db);
}

describe('persisted storage report timestamps', () => {
  it('uses the oldest member sampling time rather than the time the page opens', async () => {
    const result = await provider([
      { id: 'n1', lastHealthReport: { timestamp: 1_700_000_000 } },
      { id: 'n2', lastHealthReport: { timestamp: 1_700_000_020 } },
    ]).getSnapshot('cluster1');
    expect(result?.timestamp).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it.each([
    [{ id: 'n1', lastHealthReport: { timestamp: 1_700_000_000 } }],
    [
      { id: 'n1', lastHealthReport: { timestamp: 1_700_000_000 } },
      { id: 'n2', lastHealthReport: null },
    ],
    [
      { id: 'n1', lastHealthReport: {} },
      { id: 'n2', lastHealthReport: {} },
    ],
  ])('does not invent a fresh timestamp for incomplete reports (%j)', async (...reports) => {
    const result = await provider(reports).getSnapshot('cluster1');
    expect(result?.timestamp).toBeNull();
  });
});
