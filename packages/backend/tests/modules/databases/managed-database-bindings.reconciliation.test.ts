import { describe, expect, it, vi } from 'vitest';
import { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';

describe('managed database binding reconnect reconciliation', () => {
  it('does not migrate or fail an unrelated legacy database when only the target node reconnects', async () => {
    const database = {
      id: 'database-1',
      nodeId: 'database-node-offline',
      type: 'postgres',
      status: 'ready',
      pendingOperation: null,
      bindingIdentityVersion: 1,
    };
    const binding = {
      id: 'binding-1',
      managedDatabaseId: database.id,
      targetNodeId: 'target-node-online',
      targetType: 'container',
      targetResourceId: 'application',
      principalModelVersion: 1,
      desiredState: 'active',
      status: 'ready',
    };
    const ensureBindingIdentity = vi.fn().mockRejectedValue(new Error('database node is offline'));
    const update = vi.fn(() => {
      throw new Error('an unrelated binding must not be updated');
    });
    const instance = new ManagedDatabaseBindingService(
      {
        select: vi.fn(() => ({
          from: vi.fn(() => ({ innerJoin: vi.fn().mockResolvedValue([{ database, binding }]) })),
        })),
        update,
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      'registry.example.test/database-connector@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      false,
      undefined,
      undefined,
      { ensureBindingIdentity, finalizeBindingIdentity: vi.fn() } as never
    );

    await expect(instance.reconcileBindingPrincipals(binding.targetNodeId)).resolves.toBeUndefined();

    expect(ensureBindingIdentity).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
