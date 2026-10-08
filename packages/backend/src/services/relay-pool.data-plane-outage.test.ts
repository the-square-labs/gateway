import { describe, expect, it, vi } from 'vitest';
import type { relayInstances } from '@/db/schema/index.js';
import { LOCAL_RELAY_RECONNECT_GRACE_MS, type LocalRelayOutage } from './local-relay-outage.js';
import { RelayPoolService } from './relay-pool.service.js';

type RelayInstanceRow = typeof relayInstances.$inferSelect;

const instances = [
  { id: 'relay-uk', displayName: 'relay-1' },
  { id: 'relay-deb', displayName: 'deb-fresh-2' },
] as RelayInstanceRow[];

describe('the data-plane judgement of remote relays during a local relay outage (O-4)', () => {
  it('holds while the outage window covers, and is judged from the reports again after it', async () => {
    let outage: LocalRelayOutage | null = null;
    // The nodes report deb-fresh-2's relay port unreachable; during the outage no report arrives at all.
    let failing = new Set(['relay-deb']);
    const relayDataPlaneFailures = vi.fn(async () => failing);
    const service = new RelayPoolService({} as never, {} as never, {} as never, {} as never, {} as never);
    service.setTopology({ endpointPaths: vi.fn() as never, relayDataPlaneFailures });
    service.setLocalRelayOutage({ latestOutage: () => outage });
    const judge = () => (service as any).dataPlaneFailures(instances) as Promise<Set<string>>;

    expect([...(await judge())]).toEqual(['relay-deb']);

    const now = Date.now();
    outage = { since: now - 60_000, servingAgainAt: null, planned: false };
    failing = new Set();
    expect([...(await judge())]).toEqual(['relay-deb']);
    // Serving again: the reconnect grace still covers.
    outage = { ...outage, servingAgainAt: now - 1_000 };
    expect([...(await judge())]).toEqual(['relay-deb']);
    expect(relayDataPlaneFailures).toHaveBeenCalledTimes(1);

    outage = { ...outage, servingAgainAt: now - LOCAL_RELAY_RECONNECT_GRACE_MS - 1 };
    expect([...(await judge())]).toEqual([]);
    expect(relayDataPlaneFailures).toHaveBeenCalledTimes(2);
  });
});
