import { describe, expect, it, vi } from 'vitest';
import { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';

function service(overrides: Record<string, unknown> = {}) {
  const relayPolicy = {
    ensureBindingRoute: vi.fn(),
    getNodeGrantBundle: vi.fn(),
    revokeOwner: vi.fn(),
    getManagedDatabaseBindingRouteRuntime: vi.fn(),
    ...(overrides.relayPolicy as object),
  };
  const instance = new ManagedDatabaseBindingService(
    (overrides.db ?? {}) as any,
    (overrides.auditService ?? { log: vi.fn() }) as any,
    (overrides.cryptoService ?? {}) as any,
    (overrides.nodeDispatch ?? {}) as any,
    (overrides.dockerManagement ?? {}) as any,
    (overrides.dockerDeployments ?? {}) as any,
    (overrides.dockerSecrets ?? {}) as any,
    'unused-sidecar-image',
    false,
    relayPolicy as any,
    overrides.dockerCompose as any,
    overrides.identityManager as any
  );
  return { instance: instance as any, relayPolicy };
}

describe('managed database binding service contracts', () => {
  it('fails closed before target or database mutation when license policy wiring is absent', async () => {
    const { instance } = service();
    await expect(
      instance.create(
        'database-1',
        {
          targetNodeId: 'target-node-1',
          targetType: 'container',
          targetResourceId: 'api',
          environment: { connectionUri: 'DATABASE_URL' },
        },
        'user-1'
      )
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('emits database-scoped and target-scoped identifiers for binding changes', () => {
    const publish = vi.fn();
    const { instance } = service();
    instance.eventBus = { publish };
    instance.emitBinding(
      { id: 'database-1', databaseConnectionId: 'connection-1', name: 'orders', type: 'postgres' },
      {
        id: 'binding-1',
        targetNodeId: 'node-1',
        targetType: 'container',
        targetResourceId: 'api',
        status: 'ready',
      },
      'binding.ready'
    );

    expect(publish).toHaveBeenCalledWith(
      'database.changed',
      expect.objectContaining({ id: 'connection-1', managedDatabaseId: 'database-1', bindingId: 'binding-1' })
    );
    expect(publish).toHaveBeenCalledWith(
      'docker.container.changed',
      expect.objectContaining({ nodeId: 'node-1', containerName: 'api', bindingId: 'binding-1' })
    );
  });

  it('serializes lifecycle mutations that target the same workload', async () => {
    const { instance } = service();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const target = { targetNodeId: 'node-1', targetType: 'container', targetResourceId: 'api' };
    const first = instance.runTargetLifecycleOperation(target, async () => {
      order.push('first-start');
      await gate;
      order.push('first-end');
    });
    const second = instance.runTargetLifecycleOperation(target, async () => order.push('second'));
    await vi.waitFor(() => expect(order).toEqual(['first-start']));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('returns persisted binding state together with Relay runtime telemetry', async () => {
    const binding = {
      id: 'binding-1',
      managedDatabaseId: 'database-1',
      targetNodeId: 'node-1',
      targetType: 'container',
      targetResourceId: 'api',
      environment: {},
      status: 'ready',
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [binding]) })),
        })),
      })),
    };
    const runtime = { state: 'active', activeSessions: 3 };
    const { instance, relayPolicy } = service({
      db,
      relayPolicy: { getManagedDatabaseBindingRouteRuntime: vi.fn(async () => runtime) },
    });
    await expect(instance.getRuntime('database-1', 'binding-1')).resolves.toEqual({
      binding: expect.objectContaining({ id: 'binding-1', status: 'ready' }),
      runtime,
    });
    expect(relayPolicy.getManagedDatabaseBindingRouteRuntime).toHaveBeenCalledWith('binding-1');
  });
});
