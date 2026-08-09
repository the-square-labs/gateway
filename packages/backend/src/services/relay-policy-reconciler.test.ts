import { describe, expect, it, vi } from 'vitest';
import {
  managedDatabaseBindings,
  managedDatabaseInstances,
  nodes,
  relayEndpoints,
  relayPolicyState,
  relayRoutes,
} from '@/db/schema/index.js';
import { reconcileManagedDatabaseRelayPolicy } from './relay-policy-reconciler.js';

describe('reconcileManagedDatabaseRelayPolicy', () => {
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
