import { describe, expect, it, vi } from 'vitest';
import { relayEndpoints, relayInstances, relayPolicyState, relayPools, relayRoutes } from '@/db/schema/index.js';
import type { RelayPolicyRouteEntry } from '@/db/schema/relay.js';
import { RELAY_REVOCATION_ACK_TIMEOUT_MS } from './relay-revocation-fence.js';
import { RelayRevocationFenceService, recordBuiltPolicyRoutes } from './relay-revocation-fence.service.js';

const T0 = Date.parse('2026-09-27T10:00:00.000Z');

interface World {
  revision: number;
  issued: number;
  applied: number;
  policyRoutes: RelayPolicyRouteEntry[] | null;
  routes: Array<{ id: string; generation: number; targetEndpointId: string; sourceKind: string; sourceId: string }>;
}

function database(world: World) {
  const writes: RelayPolicyRouteEntry[][] = [];
  const execute = vi.fn();
  const answer = (table: unknown) => {
    if (table === relayPolicyState) return [{ revision: world.revision }];
    if (table === relayPools) return [{ id: 'system', revision: world.issued }];
    if (table === relayRoutes) return world.routes;
    if (table === relayEndpoints)
      return [{ id: 'endpoint-1', generation: 1, subjectKind: 'daemon', subjectId: 'node-target' }];
    if (table === relayInstances)
      return world.policyRoutes
        ? [
            {
              id: 'relay-1',
              poolId: 'system',
              displayName: 'edge-1',
              appliedPolicyRevision: world.applied,
              policyRoutes: world.policyRoutes,
            },
          ]
        : [];
    return [];
  };
  const db: any = {
    select: () => {
      let table: unknown;
      const query: any = {
        from: (value: unknown) => {
          table = value;
          return query;
        },
        where: () => query,
        limit: () => query,
        // biome-ignore lint/suspicious/noThenProperty: emulate Drizzle's lazy thenable query
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(answer(table)).then(resolve),
      };
      return query;
    },
    execute,
    update: () => ({
      set: (values: { policyRoutes: RelayPolicyRouteEntry[] }) => ({
        where: async () => {
          writes.push(values.policyRoutes);
          world.policyRoutes = values.policyRoutes;
        },
      }),
    }),
  };
  db.transaction = (fn: (tx: unknown) => unknown) => fn(db);
  return { db, writes, execute };
}

const kept = { routeId: 'route-kept', endpointId: 'endpoint-1', routeGeneration: 1, endpointGeneration: 1 };
const revoked = { routeId: 'route-revoked', endpointId: 'endpoint-1', routeGeneration: 1, endpointGeneration: 1 };
const keptRow = {
  id: 'route-kept',
  generation: 1,
  targetEndpointId: 'endpoint-1',
  sourceKind: 'daemon',
  sourceId: 'node-a',
};
const narrowedRow = {
  id: 'route-revoked',
  generation: 2,
  targetEndpointId: 'endpoint-1',
  sourceKind: 'daemon',
  sourceId: 'node-b',
};

describe('RelayRevocationFenceService', () => {
  it('records built tuples inside the snapshot transaction', async () => {
    const world: World = { revision: 5, issued: 10, applied: 10, policyRoutes: [kept, revoked], routes: [keptRow] };
    const { db, writes } = database(world);
    await recordBuiltPolicyRoutes(db, { id: 'relay-1', policyRoutes: world.policyRoutes }, [kept], 11);
    expect(writes).toEqual([[kept, { ...revoked, removedAtRevision: 11 }]]);
  });

  it('fences a relay that missed the revocation, notifies the affected daemons and clears on acknowledgement', async () => {
    const world: World = {
      revision: 5,
      issued: 11,
      applied: 10,
      policyRoutes: [kept, { ...revoked, removedAtRevision: 11 }],
      routes: [keptRow, narrowedRow],
    };
    const { db, execute } = database(world);
    const service = new RelayRevocationFenceService(db);

    await expect(service.evaluate(new Date(T0))).resolves.toEqual({ transitions: [], nodeIds: [] });
    expect(execute).toHaveBeenCalledTimes(1);
    const stale = await service.evaluate(new Date(T0 + RELAY_REVOCATION_ACK_TIMEOUT_MS));
    expect(stale).toEqual({
      transitions: [{ instanceId: 'relay-1', poolId: 'system', displayName: 'edge-1', stale: true, staleRoutes: 1 }],
      // The source of the narrowed route loses the relay; the endpoint daemon gains the fence.
      nodeIds: ['node-b', 'node-target'],
    });
    expect(world.policyRoutes?.find(({ routeId }) => routeId === 'route-kept')).toEqual(kept);

    // A report of a revision Gateway never issued acknowledges nothing.
    world.applied = 50;
    await expect(service.evaluate(new Date(T0 + 200_000))).resolves.toEqual({ transitions: [], nodeIds: [] });
    expect(world.policyRoutes?.some(({ staleAt }) => staleAt)).toBe(true);

    world.applied = 11;
    const cleared = await service.evaluate(new Date(T0 + 300_000));
    expect(cleared.transitions).toEqual([
      { instanceId: 'relay-1', poolId: 'system', displayName: 'edge-1', stale: false, staleRoutes: 0 },
    ]);
    expect(cleared.nodeIds).toEqual(['node-b', 'node-target']);
    expect(world.policyRoutes).toEqual([kept]);
  });

  it('skips the revision lock when policy did not change and no relay holds a dropped tuple', async () => {
    const world: World = { revision: 5, issued: 11, applied: 11, policyRoutes: null, routes: [keptRow] };
    const { db, execute } = database(world);
    const service = new RelayRevocationFenceService(db);
    await service.evaluate(new Date(T0));
    await service.evaluate(new Date(T0 + 5_000));
    expect(execute).not.toHaveBeenCalled();
  });
});
