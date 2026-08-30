import { describe, expect, it, vi } from 'vitest';
import { ManagedDatabaseBindingTargetRuntime } from '@/modules/databases/managed-database-binding-target-runtime.js';

const database = { id: 'database-1', nodeId: 'database-node-1', type: 'postgres' } as any;
const binding = {
  id: '11111111-1111-4111-8111-111111111111',
  managedDatabaseId: database.id,
  targetNodeId: 'target-node-1',
  targetType: 'container',
  targetResourceId: 'api',
  networkName: 'gateway-db-1111111111114111',
  connectorName: 'gateway-db-connector-1111111111114111',
  connectorAlias: 'db-1111111111114111',
  connectorAddress: null,
  environment: { connectionUri: 'DATABASE_URL' },
} as any;
const credentials = { username: 'binding', password: 'secret', databaseName: 'app' };

function harness(options: { listenerState?: 'ready' | 'error'; inspect?: ReturnType<typeof vi.fn> } = {}) {
  const order: string[] = [];
  const inspect =
    options.inspect ??
    vi.fn(async () => ({
      Id: 'container-new',
      State: { Running: true },
      NetworkSettings: { Networks: { [binding.networkName]: {} } },
      HostConfig: { ExtraHosts: [`${binding.connectorAlias}:172.28.0.1`] },
    }));
  const sendDockerNetworkCommand = vi.fn(async (_nodeId: string, action: string) => {
    order.push(`network:${action}`);
    if (action === 'list') {
      return {
        success: true,
        detail: JSON.stringify([
          { Name: binding.networkName, Driver: 'bridge', IPAM: { Config: [{ Gateway: '172.28.0.1' }] } },
        ]),
      };
    }
    return { success: true };
  });
  const sendRelayGrantBundle = vi.fn(async () => {
    order.push('grant-sync');
    return {
      success: true,
      detail: JSON.stringify({
        listenerStatuses: {
          [binding.id]: {
            state: options.listenerState ?? 'ready',
            address: '172.28.0.1',
            ...(options.listenerState === 'error' ? { error: 'bind failed' } : {}),
          },
        },
      }),
    };
  });
  const sendDockerContainerCommand = vi.fn(async (_nodeId: string, action: string) => {
    order.push(`container:${action}`);
    return { success: true };
  });
  const ensureBindingRoute = vi.fn(async (...args: unknown[]) => {
    order.push('route');
    return String(args[0]);
  });
  const probeManagedDatabaseBindingRoute = vi.fn(async () => {
    order.push('route-probe');
  });
  const db = {
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
  } as any;
  const runtime = new ManagedDatabaseBindingTargetRuntime(
    db,
    { sendDockerNetworkCommand, sendRelayGrantBundle, sendDockerContainerCommand } as any,
    {
      inspectContainer: inspect,
      getContainerEnv: vi.fn(async () => []),
      updateContainerEnv: vi.fn(async () => {
        order.push('container:update-env');
        return { name: 'api' };
      }),
      listContainers: vi.fn(async () => []),
    } as any,
    {} as any,
    { create: vi.fn(), list: vi.fn(async () => []), delete: vi.fn() } as any,
    { ensureBindingRoute, syncNodeGrantBundle: sendRelayGrantBundle, probeManagedDatabaseBindingRoute } as any
  );
  runtime.setReconciler({ reconcileTargetNode: vi.fn(async () => order.push('target-reconcile')), releaseTargetNetwork: vi.fn() });
  return {
    runtime,
    order,
    inspect,
    ensureBindingRoute,
    probeManagedDatabaseBindingRoute,
    sendRelayGrantBundle,
    sendDockerContainerCommand,
    sendDockerNetworkCommand,
  };
}

describe('managed database binding target runtime', () => {
  it('requires listener ACK, validates the target mapping, then removes the legacy sidecar', async () => {
    const test = harness();
    await test.runtime.reconcile(database, { ...binding }, credentials);

    expect(test.ensureBindingRoute).toHaveBeenCalledWith(
      binding.id,
      binding.managedDatabaseId,
      binding.targetNodeId,
      database.nodeId,
      {
        networkName: binding.networkName,
        listenAddress: '172.28.0.1',
        listenPort: 5432,
        allowedSources: ['container:api'],
      }
    );
    expect(test.order.indexOf('grant-sync')).toBeLessThan(test.order.indexOf('container:remove'));
    expect(test.order.lastIndexOf('grant-sync')).toBeLessThan(test.order.indexOf('route-probe'));
    expect(test.order.indexOf('route-probe')).toBeLessThan(test.order.indexOf('container:remove'));
    expect(test.inspect).toHaveBeenCalledWith(binding.targetNodeId, binding.targetResourceId);
  });

  it('rolls the target when its alias is stale and removes the sidecar only after revalidation', async () => {
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({
        NetworkSettings: { Networks: { [binding.networkName]: {} } },
        HostConfig: { ExtraHosts: [] },
      })
      .mockResolvedValueOnce({
        NetworkSettings: { Networks: { [binding.networkName]: {} } },
        HostConfig: { ExtraHosts: [`${binding.connectorAlias}:172.28.0.1`] },
      });
    const test = harness({ inspect });
    const apply = vi.spyOn(test.runtime, 'apply').mockImplementation(async () => {
      test.order.push('target-apply');
    });

    await test.runtime.reconcile(database, { ...binding }, credentials);

    expect(apply).toHaveBeenCalledOnce();
    expect(test.ensureBindingRoute).toHaveBeenCalledTimes(2);
    expect(test.order.indexOf('target-apply')).toBeLessThan(test.order.indexOf('container:remove'));
    expect(test.order.lastIndexOf('grant-sync')).toBeGreaterThan(test.order.indexOf('target-reconcile'));
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('fails closed without touching the target or sidecar when listener startup is not acknowledged', async () => {
    const test = harness({ listenerState: 'error' });
    const apply = vi.spyOn(test.runtime, 'apply');
    await expect(test.runtime.reconcile(database, { ...binding }, credentials)).rejects.toThrow('bind failed');
    expect(apply).not.toHaveBeenCalled();
    expect(test.sendDockerContainerCommand).not.toHaveBeenCalled();
  });

  it('disconnects a deleted binding network before recreating the target environment', async () => {
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ Id: 'container-old', Name: '/api', State: { Running: true, Status: 'running' } })
      .mockResolvedValueOnce({ Id: 'container-new', Name: '/api', State: { Running: true, Status: 'running' } });
    const test = harness({ inspect });

    await test.runtime.remove(database, { ...binding }, credentials, 'user-1');

    expect(test.sendDockerNetworkCommand).toHaveBeenCalledWith(binding.targetNodeId, 'disconnect', {
      networkId: binding.networkName,
      containerId: binding.targetResourceId,
    });
    expect(test.order.indexOf('network:disconnect')).toBeLessThan(test.order.indexOf('container:update-env'));
  });

  it('finishes binding removal when a recreated workload intentionally remains created', async () => {
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ Id: 'container-old', Name: '/api', State: { Running: false, Status: 'created' } })
      .mockResolvedValueOnce({ Id: 'container-new', Name: '/api', State: { Running: false, Status: 'created' } });
    const test = harness({ inspect });

    await expect(test.runtime.remove(database, { ...binding }, credentials, 'user-1')).resolves.toBeUndefined();

    expect(test.order.indexOf('network:disconnect')).toBeLessThan(test.order.indexOf('container:update-env'));
    expect(inspect).toHaveBeenCalledTimes(2);
  });
});
