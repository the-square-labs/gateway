import { describe, expect, it, vi } from 'vitest';
import { ManagedDatabaseBindingIdentityRuntime } from '@/modules/databases/managed-database-binding-identity-runtime.js';

function migrationHarness(options: { ownerShared?: boolean; failDrop?: boolean; pauseRuntime?: Promise<void> } = {}) {
  const database = {
    id: 'database-1',
    nodeId: 'database-node-1',
    type: 'postgres',
    applicationPrincipalName: 'app_role',
    engineConfig: { ownerUsername: 'owner' },
  } as any;
  const binding = {
    id: '11111111-1111-4111-8111-111111111111',
    managedDatabaseId: database.id,
    targetNodeId: 'target-node-1',
    targetType: 'container',
    targetResourceId: 'api',
    principalModelVersion: 0,
    principalOperationId: null,
    credentialGeneration: 0,
  } as any;
  const legacy = {
    username: options.ownerShared ? 'owner' : 'legacy_binding',
    password: 'legacy-secret',
    databaseName: 'app',
  };
  const owner = { username: 'owner', password: 'owner-secret', databaseName: 'app' };
  const sets: Array<Record<string, unknown>> = [];
  let returningCount = 0;
  const db = {
    update: vi.fn(() => ({
      set: vi.fn((value: Record<string, unknown>) => {
        sets.push(value);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              returningCount += 1;
              if (returningCount === 1) {
                return [
                  {
                    ...binding,
                    pendingEncryptedCredentials: JSON.stringify({ encryptedKey: 'key', encryptedDek: 'dek' }),
                    principalName: 'gw_b_111111111111411181111111',
                    principalOperationId: '22222222-2222-4222-8222-222222222222',
                    credentialGeneration: 1,
                  },
                ];
              }
              return [{ ...binding, principalModelVersion: 2, status: 'ready', observedState: 'active' }];
            }),
          })),
        };
      }),
    })),
  } as any;
  const order: string[] = [];
  const sendDockerDatabaseCommand = vi.fn(async (_nodeId: string, action: string) => {
    order.push(action);
    if (action === 'binding_principal_drop_v2' && options.failDrop) {
      return { success: false, error: 'drop failed' };
    }
    return { success: true };
  });
  const callbacks = {
    getBinding: vi.fn(),
    getDatabase: vi.fn(),
    assertTargetReady: vi.fn(),
    markError: vi.fn(),
    deprovision: vi.fn(),
    reconcileDesired: vi.fn(),
    reconcileRuntime: vi.fn(async () => {
      order.push('runtime');
      await options.pauseRuntime;
    }),
    applyTarget: vi.fn(async () => order.push('target')),
    verifyTarget: vi.fn(async () => order.push('verify')),
    reconcileTargetNode: vi.fn(async () => order.push('target-reconcile')),
    emitReady: vi.fn(),
    emitDeleted: vi.fn(),
    runDatabaseOperation: vi.fn(async (_id: string, operation: () => Promise<unknown>) => operation()),
    runTargetOperation: vi.fn(async (_row: unknown, operation: () => Promise<unknown>) => operation()),
    bindingCredentials: vi.fn(() => legacy),
    pendingBindingCredentials: vi.fn(() => null),
    ownerCredentials: vi.fn(() => owner),
    bindingPrincipalPayload: vi.fn(() => '{}'),
  } as any;
  const runtime = new ManagedDatabaseBindingIdentityRuntime(
    db,
    { encryptString: vi.fn(() => ({ encryptedKey: 'key', encryptedDek: 'dek' })) } as any,
    { sendDockerDatabaseCommand } as any,
    callbacks
  );
  return { runtime, database, binding, order, sets, sendDockerDatabaseCommand };
}

describe('managed database binding identity migration', () => {
  it('promotes pending credentials only after runtime cutover, verification, and legacy-principal retirement', async () => {
    const harness = migrationHarness();
    const result = await harness.runtime.ensurePrincipal(harness.database, harness.binding);

    expect(result.principalModelVersion).toBe(2);
    expect(harness.order).toEqual([
      'binding_principal_apply_v2',
      'binding_principal_probe_v2',
      'runtime',
      'target',
      'target-reconcile',
      'verify',
      'binding_principal_drop_v2',
    ]);
    expect(harness.sets.at(-1)).toEqual(expect.objectContaining({ principalModelVersion: 2 }));
  });

  it('preserves the PostgreSQL owner role instead of dropping an owner-shared legacy principal', async () => {
    const harness = migrationHarness({ ownerShared: true });
    await harness.runtime.ensurePrincipal(harness.database, harness.binding);
    expect(harness.sendDockerDatabaseCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      'binding_principal_drop_v2',
      expect.anything(),
      expect.anything()
    );
    expect(harness.sets.at(-1)).toEqual(expect.objectContaining({ principalModelVersion: 2 }));
  });

  it('does not promote pending credentials when legacy-principal retirement fails', async () => {
    const harness = migrationHarness({ failDrop: true });
    await expect(harness.runtime.ensurePrincipal(harness.database, harness.binding)).rejects.toThrow('drop failed');
    expect(harness.sets.some((value) => value.principalModelVersion === 2)).toBe(false);
  });

  it('coalesces concurrent migration attempts for one binding', async () => {
    let release!: () => void;
    const pauseRuntime = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = migrationHarness({ pauseRuntime });
    const first = harness.runtime.ensurePrincipal(harness.database, harness.binding);
    const second = harness.runtime.ensurePrincipal(harness.database, harness.binding);
    await vi.waitFor(() => expect(harness.order).toContain('runtime'));
    release();
    await Promise.all([first, second]);
    expect(
      harness.sendDockerDatabaseCommand.mock.calls.filter(([, action]) => action === 'binding_principal_apply_v2')
    ).toHaveLength(1);
  });
});
