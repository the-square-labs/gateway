import { describe, expect, it, vi } from 'vitest';
import { reconcileManagedDatabaseBindingLifecycle } from '@/modules/databases/managed-database-binding-lifecycle.js';

describe('managed database binding persisted lifecycle', () => {
  it('reconciles active state monotonically from principal to verified runtime', async () => {
    const order: string[] = [];
    const binding = { desiredState: 'active' as const, id: 'binding-1' };
    const result = await reconcileManagedDatabaseBindingLifecycle(binding, binding, {
      markDeleting: vi.fn(),
      revokeAccess: vi.fn(),
      deprovision: vi.fn(),
      deleteRecord: vi.fn(),
      ensurePrincipal: vi.fn(async (row) => {
        order.push('principal');
        return row;
      }),
      markPrincipalReady: vi.fn(async (row) => {
        order.push('principal_ready');
        return row;
      }),
      ensureRuntime: vi.fn(async () => {
        order.push('runtime');
      }),
      markReady: vi.fn(async (row) => {
        order.push('ready');
        return row;
      }),
    });

    expect(result).toEqual({ deleted: false, binding });
    expect(order).toEqual(['principal', 'principal_ready', 'runtime', 'ready']);
  });

  it('never executes active steps after desired state becomes deleted', async () => {
    const order: string[] = [];
    const binding = { desiredState: 'deleted' as const, id: 'binding-1' };
    const activeStep = vi.fn();
    const result = await reconcileManagedDatabaseBindingLifecycle(binding, binding, {
      markDeleting: vi.fn(async () => {
        order.push('deleting');
        return binding;
      }),
      revokeAccess: vi.fn(async () => order.push('revoke')),
      deprovision: vi.fn(async () => order.push('deprovision')),
      deleteRecord: vi.fn(async () => order.push('delete')),
      ensurePrincipal: activeStep,
      markPrincipalReady: activeStep,
      ensureRuntime: activeStep,
      markReady: activeStep,
    });

    expect(result).toEqual({ deleted: true });
    expect(order).toEqual(['deleting', 'revoke', 'deprovision', 'delete']);
    expect(activeStep).not.toHaveBeenCalled();
  });
});
