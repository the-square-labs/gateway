import { describe, expect, it, vi } from 'vitest';
import {
  dockerAvailabilityPolicies,
  managedDatabaseBindingPlacements,
  managedDatabaseBindings,
  managedDatabaseInstances,
  managedStorageBindings,
  nodes,
  relayEndpoints,
  relayPolicyState,
  relayRoutes,
} from '@/db/schema/index.js';
import { reconcileManagedDatabaseRelayPolicy, reconcileManagedStorageRelayPolicy } from './relay-policy-reconciler.js';

describe('reconcileManagedDatabaseRelayPolicy', () => {
  it('keeps placement-owned database routes and removes the superseded logical parent route', async () => {
    const fingerprint = `sha256:${'a'.repeat(64)}`;
    const endpoint = {
      id: 'endpoint-1',
      ownerId: 'database-1',
      subjectId: 'database-node',
      certificateSha256: fingerprint,
      status: 'active',
    };
    const parentRoute = { id: 'route-parent', ownerId: 'binding-1' };
    const placementRoute = {
      id: 'route-placement',
      ownerId: 'projection-1',
      sourceId: 'workload-node',
      sourceCertificateSha256: fingerprint,
      targetEndpointId: endpoint.id,
    };
    const canonical = new Map<unknown, unknown[]>([
      [managedDatabaseInstances, [{ id: 'database-1', nodeId: 'database-node', status: 'ready' }]],
      [
        managedDatabaseBindings,
        [
          {
            id: 'binding-1',
            managedDatabaseId: 'database-1',
            sourceNodeId: 'origin-node',
            targetType: 'container',
            targetResourceId: 'api',
            desiredState: 'active',
            status: 'ready',
          },
        ],
      ],
      [
        managedDatabaseBindingPlacements,
        [
          {
            id: 'projection-1',
            bindingId: 'binding-1',
            availabilityPlacementId: 'placement-1',
            sourceNodeId: 'workload-node',
            desiredState: 'active',
            status: 'ready',
          },
        ],
      ],
      [
        dockerAvailabilityPolicies,
        [
          {
            mode: 'replicated',
            resourceKind: 'container',
            sourceNodeId: 'origin-node',
            containerName: 'api',
          },
        ],
      ],
      [
        nodes,
        [
          { id: 'database-node', certificateFingerprint: fingerprint },
          { id: 'workload-node', certificateFingerprint: fingerprint },
        ],
      ],
    ]);
    const deletedTables: unknown[] = [];
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: () =>
            Promise.resolve(
              table === relayEndpoints ? [endpoint] : table === relayRoutes ? [parentRoute, placementRoute] : []
            ),
        }),
      })),
      delete: vi.fn((table: unknown) => {
        deletedTables.push(table);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
      update: vi.fn((_table: unknown) => ({
        set: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
      })),
      insert: vi.fn(),
    };
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => Promise.resolve(canonical.get(table) ?? []),
      })),
      transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)),
    };

    await reconcileManagedDatabaseRelayPolicy(db as never);

    expect(deletedTables.filter((table) => table === relayRoutes)).toHaveLength(1);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('keeps the adopted parent route while Availability is disabling', async () => {
    const fingerprint = `sha256:${'a'.repeat(64)}`;
    const endpoint = {
      id: 'endpoint-1',
      ownerId: 'database-1',
      subjectId: 'database-node',
      certificateSha256: fingerprint,
      status: 'active',
    };
    const parentRoute = {
      id: 'route-parent',
      ownerId: 'binding-1',
      sourceId: 'survivor-node',
      sourceCertificateSha256: fingerprint,
      targetEndpointId: endpoint.id,
    };
    const canonical = new Map<unknown, unknown[]>([
      [managedDatabaseInstances, [{ id: 'database-1', nodeId: 'database-node', status: 'ready' }]],
      [
        managedDatabaseBindings,
        [
          {
            id: 'binding-1',
            managedDatabaseId: 'database-1',
            sourceNodeId: 'survivor-node',
            targetType: 'deployment',
            targetResourceId: 'deployment-1',
            desiredState: 'active',
            status: 'ready',
          },
        ],
      ],
      [
        managedDatabaseBindingPlacements,
        [
          {
            id: 'projection-1',
            bindingId: 'binding-1',
            availabilityPlacementId: null,
            sourceNodeId: 'survivor-node',
            desiredState: 'active',
            status: 'ready',
          },
        ],
      ],
      [
        dockerAvailabilityPolicies,
        [
          {
            mode: 'failover',
            status: 'disabling',
            resourceKind: 'deployment',
            deploymentId: 'deployment-1',
          },
        ],
      ],
      [
        nodes,
        [
          { id: 'database-node', certificateFingerprint: fingerprint },
          { id: 'survivor-node', certificateFingerprint: fingerprint },
        ],
      ],
    ]);
    const deletedTables: unknown[] = [];
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: () =>
            Promise.resolve(table === relayEndpoints ? [endpoint] : table === relayRoutes ? [parentRoute] : []),
        }),
      })),
      delete: vi.fn((table: unknown) => {
        deletedTables.push(table);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
      update: vi.fn(() => ({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) })),
      insert: vi.fn(),
    };
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => Promise.resolve(canonical.get(table) ?? []),
      })),
      transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)),
    };

    await reconcileManagedDatabaseRelayPolicy(db as never);

    expect(deletedTables).not.toContain(relayRoutes);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('removes an orphaned binding route after direct revocation failed and canonical deletion committed', async () => {
    const endpoint = {
      id: 'endpoint-1',
      ownerId: 'database-1',
      subjectId: 'node-target',
      certificateSha256: `sha256:${'a'.repeat(64)}`,
      status: 'active',
    };
    const route = { id: 'route-1', ownerId: 'deleted-binding' };
    const canonical = new Map<unknown, unknown[]>([
      [managedDatabaseInstances, [{ id: 'database-1', nodeId: 'node-target', status: 'ready' }]],
      [managedDatabaseBindings, []],
      [nodes, [{ id: 'node-target', certificateFingerprint: `sha256:${'a'.repeat(64)}` }]],
    ]);
    const deletedTables: unknown[] = [];
    const updatedTables: unknown[] = [];
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: () => Promise.resolve(table === relayEndpoints ? [endpoint] : table === relayRoutes ? [route] : []),
        }),
      })),
      delete: vi.fn((table: unknown) => {
        deletedTables.push(table);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
      update: vi.fn((table: unknown) => {
        updatedTables.push(table);
        return { set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) };
      }),
      insert: vi.fn(),
    };
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => Promise.resolve(canonical.get(table) ?? []),
      })),
      transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)),
    };

    await reconcileManagedDatabaseRelayPolicy(db as never);

    expect(deletedTables).toContain(relayRoutes);
    expect(deletedTables).not.toContain(relayEndpoints);
    expect(updatedTables).toContain(relayPolicyState);
  });

  it('keeps the route of a link that is still being created or failed a reconcile, until it is deleted', async () => {
    const fingerprint = `sha256:${'a'.repeat(64)}`;
    const endpoint = {
      id: 'endpoint-1',
      ownerId: 'database-1',
      subjectId: 'database-node',
      certificateSha256: fingerprint,
      status: 'active',
    };
    const routeFor = (ownerId: string) => ({
      id: `route-${ownerId}`,
      ownerId,
      sourceId: 'workload-node',
      sourceCertificateSha256: fingerprint,
      targetEndpointId: endpoint.id,
    });
    const binding = (id: string, status: string, desiredState = 'active') => ({
      id,
      managedDatabaseId: 'database-1',
      sourceNodeId: 'workload-node',
      targetType: 'deployment',
      targetResourceId: `deployment-${id}`,
      desiredState,
      status,
    });
    const canonical = new Map<unknown, unknown[]>([
      [managedDatabaseInstances, [{ id: 'database-1', nodeId: 'database-node', status: 'ready' }]],
      [
        managedDatabaseBindings,
        [
          binding('creating-link', 'creating'),
          binding('failed-link', 'error'),
          binding('deleting-link', 'deleting', 'deleted'),
        ],
      ],
      [
        nodes,
        [
          { id: 'database-node', certificateFingerprint: fingerprint },
          { id: 'workload-node', certificateFingerprint: fingerprint },
        ],
      ],
    ]);
    const deletedRoutes: unknown[] = [];
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: () =>
            Promise.resolve(
              table === relayEndpoints
                ? [endpoint]
                : table === relayRoutes
                  ? [routeFor('creating-link'), routeFor('failed-link'), routeFor('deleting-link')]
                  : []
            ),
        }),
      })),
      delete: vi.fn((table: unknown) => ({
        where: vi.fn((condition: unknown) => {
          if (table === relayRoutes) deletedRoutes.push(condition);
          return Promise.resolve(undefined);
        }),
      })),
      update: vi.fn((_table: unknown) => ({
        set: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
      })),
      insert: vi.fn(),
    };
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => Promise.resolve(canonical.get(table) ?? []),
      })),
      transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)),
    };

    await reconcileManagedDatabaseRelayPolicy(db as never);

    // Only the link being deleted loses its route; nothing is recreated for the other two.
    expect(deletedRoutes).toHaveLength(1);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('removes an endpoint whose canonical target node no longer has an identity', async () => {
    const endpoint = {
      id: 'endpoint-1',
      ownerId: 'database-1',
      subjectId: 'deleted-node',
      certificateSha256: `sha256:${'a'.repeat(64)}`,
      status: 'active',
    };
    const canonical = new Map<unknown, unknown[]>([
      [managedDatabaseInstances, [{ id: 'database-1', nodeId: 'deleted-node', status: 'ready' }]],
      [managedDatabaseBindings, []],
      [nodes, []],
    ]);
    const deletedTables: unknown[] = [];
    let endpointReads = 0;
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === relayEndpoints) {
              endpointReads += 1;
              return Promise.resolve(endpointReads === 1 ? [endpoint] : []);
            }
            return Promise.resolve([]);
          },
        }),
      })),
      delete: vi.fn((table: unknown) => {
        deletedTables.push(table);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
      update: vi.fn(() => ({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) })),
      insert: vi.fn(),
    };
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => Promise.resolve(canonical.get(table) ?? []),
      })),
      transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)),
    };

    await reconcileManagedDatabaseRelayPolicy(db as never);

    expect(deletedTables).toContain(relayEndpoints);
  });
});

describe('reconcileManagedStorageRelayPolicy', () => {
  it('removes the route of a storage link that no longer exists and keeps the others', async () => {
    const deletedRoutes: unknown[] = [];
    const updatedTables: unknown[] = [];
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({
        from: (table: unknown) =>
          table === managedStorageBindings
            ? Promise.resolve([{ id: 'live-link' }])
            : {
                where: () =>
                  Promise.resolve(
                    table === relayRoutes
                      ? [
                          { id: 'route-live', ownerId: 'live-link' },
                          { id: 'route-orphan', ownerId: 'deleted-link' },
                        ]
                      : []
                  ),
              },
      })),
      delete: vi.fn((table: unknown) => ({
        where: vi.fn((condition: unknown) => {
          if (table === relayRoutes) deletedRoutes.push(condition);
          return Promise.resolve(undefined);
        }),
      })),
      update: vi.fn((table: unknown) => {
        updatedTables.push(table);
        return { set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) };
      }),
    };
    const db = { transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)) };

    await reconcileManagedStorageRelayPolicy(db as never);

    expect(deletedRoutes).toHaveLength(1);
    expect(updatedTables).toContain(relayPolicyState);
  });
});
