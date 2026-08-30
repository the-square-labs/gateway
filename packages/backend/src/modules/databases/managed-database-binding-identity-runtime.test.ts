import { describe, expect, it, vi } from 'vitest';
import { ManagedDatabaseBindingIdentityRuntime } from './managed-database-binding-identity-runtime.js';

describe('ManagedDatabaseBindingIdentityRuntime reconnect reconciliation', () => {
  it('retries a legacy binding when the target daemon reconnects after the database daemon', async () => {
    const database = {
      id: 'database-1',
      nodeId: 'database-node',
      status: 'ready',
      pendingOperation: null,
      bindingIdentityVersion: 0,
      type: 'postgres',
    };
    const binding = {
      id: 'binding-1',
      managedDatabaseId: database.id,
      targetNodeId: 'target-node',
      principalModelVersion: 0,
    };
    const migratedDatabase = { ...database, bindingIdentityVersion: 2 };
    const migratedBinding = { ...binding, principalModelVersion: 2 };
    const innerJoin = vi.fn().mockResolvedValue([{ database, binding }]);
    const callbacks = {
      getBinding: vi.fn().mockResolvedValue(migratedBinding),
      getDatabase: vi.fn().mockResolvedValue(migratedDatabase),
      assertDatabaseReady: vi.fn().mockResolvedValue(undefined),
      assertTargetReady: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn(),
      deprovision: vi.fn(),
      reconcileDesired: vi.fn().mockResolvedValue(undefined),
      reconcileRuntime: vi.fn(),
      applyTarget: vi.fn(),
      verifyTarget: vi.fn(),
      reconcileTargetNode: vi.fn(),
      emitReady: vi.fn(),
      emitDeleted: vi.fn(),
      runDatabaseOperation: vi.fn(async (_id: string, operation: () => Promise<unknown>) => operation()),
      runTargetOperation: vi.fn(async (_binding: unknown, operation: () => Promise<unknown>) => operation()),
      bindingCredentials: vi.fn(),
      pendingBindingCredentials: vi.fn(),
      ownerCredentials: vi.fn(),
      bindingPrincipalPayload: vi.fn(),
    };
    const identityManager = {
      ensureBindingIdentity: vi.fn().mockResolvedValue(migratedDatabase),
      finalizeBindingIdentity: vi.fn().mockResolvedValue(migratedDatabase),
    };
    const runtime = new ManagedDatabaseBindingIdentityRuntime(
      { select: vi.fn(() => ({ from: vi.fn(() => ({ innerJoin })) })) } as never,
      {} as never,
      {} as never,
      callbacks as never,
      identityManager as never
    );

    await runtime.reconcile('target-node');

    expect(callbacks.assertTargetReady).toHaveBeenCalledWith('target-node');
    expect(callbacks.assertDatabaseReady).toHaveBeenCalledWith('database-node');
    expect(identityManager.ensureBindingIdentity).toHaveBeenCalledWith(database.id, null);
    expect(callbacks.reconcileDesired).toHaveBeenCalledWith(migratedDatabase, migratedBinding);
    expect(callbacks.markError).not.toHaveBeenCalled();
  });
});
