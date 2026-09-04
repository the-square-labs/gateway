import { describe, expect, it, vi } from 'vitest';
import { availabilityComposeProjectName, ManagedDatabaseBindingService } from './managed-database-bindings.service.js';

function updateRecorder(records: Array<Record<string, unknown>>) {
  return vi.fn(() => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        records.push(values);
        return [];
      },
    }),
  }));
}

describe('Managed database Availability projections', () => {
  it('authorizes a Compose placement by its actual runtime project name', () => {
    const context = {
      policyId: '8c9e1e5b-def9-4472-8882-5a5ac9d86fcf',
      placementId: '4931a895-fda0-49f7-b4e4-b8dd839874d1',
      nodeId: 'placement-node',
      resource: {
        currentNodeId: 'origin-node',
        displayName: 'availability-compose',
      },
    } as any;

    expect(availabilityComposeProjectName(context)).toBe('gwav-compose-8c9e1e5b-4931a895');
    expect(availabilityComposeProjectName({ ...context, nodeId: 'origin-node' })).toBe('availability-compose');
  });

  it('marks a logical binding ready and queues an Availability dependency rollout without mutating one placement', async () => {
    const database = { id: 'database-1' };
    const binding = {
      id: 'binding-1',
      desiredState: 'active',
      observedState: 'error',
      status: 'error',
    };
    const coordinator = {
      resolvePolicyId: vi.fn().mockResolvedValue('policy-1'),
      queueDependencyRollout: vi.fn().mockResolvedValue(undefined),
    };
    const subject = Object.create(ManagedDatabaseBindingService.prototype) as any;
    subject.availabilityCoordinator = coordinator;
    subject.identityRuntime = { ensurePrincipal: vi.fn().mockResolvedValue(binding) };
    subject.reconcileBindingRuntime = vi.fn();
    subject.emitBinding = vi.fn();
    subject.db = {
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({ returning: async () => [{ ...binding, ...values }] }),
        }),
      })),
    };

    await expect(subject.reconcileDesiredBinding(database, binding, 'user-1', {}, 'request')).resolves.toMatchObject({
      deleted: false,
      binding: expect.objectContaining({ status: 'ready', observedState: 'active' }),
    });
    expect(subject.reconcileBindingRuntime).not.toHaveBeenCalled();
    expect(coordinator.resolvePolicyId).toHaveBeenCalledWith(binding);
    expect(coordinator.queueDependencyRollout).toHaveBeenCalledWith('policy-1', 'user-1');
  });

  it('keeps failed placement cleanup durable and retryable', async () => {
    const updates: Array<Record<string, unknown>> = [];
    let deleted = false;
    let selectCalls = 0;
    const subject = Object.create(ManagedDatabaseBindingService.prototype) as any;
    subject.db = {
      select: () => ({
        from: () => ({
          where: () => {
            selectCalls += 1;
            if (selectCalls === 1) {
              return Promise.resolve([
                {
                  id: 'projection-1',
                  bindingId: 'binding-1',
                  nodeId: 'node-1',
                  networkName: 'gateway-db-av-1',
                },
              ]);
            }
            return { limit: async () => [] };
          },
        }),
      }),
      update: updateRecorder(updates),
      delete: () => ({
        where: async () => {
          deleted = true;
        },
      }),
    };
    subject.relayPolicy = {
      revokeOwner: vi.fn().mockResolvedValue(undefined),
      syncNodeGrantBundle: vi.fn().mockResolvedValue({ success: true }),
    };
    subject.targetRuntimeReconciler = {
      releaseTargetNetwork: vi.fn().mockResolvedValue(undefined),
      reconcileTargetNode: vi.fn().mockResolvedValue(undefined),
    };
    subject.nodeDispatch = {
      sendDockerNetworkCommand: vi.fn().mockResolvedValue({ success: false, error: 'node unavailable' }),
    };

    await expect(subject.cleanupAvailabilityPlacement('placement-1')).rejects.toMatchObject({
      code: 'AVAILABILITY_DATABASE_CLEANUP_PENDING',
      details: expect.objectContaining({ retryable: true, projectionId: 'projection-1' }),
    });
    expect(deleted).toBe(false);
    expect(subject.targetRuntimeReconciler.releaseTargetNetwork).toHaveBeenCalledWith('node-1', 'gateway-db-av-1');
    expect(subject.targetRuntimeReconciler.reconcileTargetNode).toHaveBeenCalledWith('node-1');
    expect(subject.relayPolicy.syncNodeGrantBundle).toHaveBeenCalledWith('node-1');
    expect(updates).toContainEqual(expect.objectContaining({ desiredState: 'deleted', status: 'deleting' }));
    expect(updates).toContainEqual(
      expect.objectContaining({
        observedState: 'error',
        status: 'error',
        lastError: expect.stringContaining('node unavailable'),
      })
    );
  });

  it('adopts the surviving projection without deleting a parent runtime still owned by another placement', async () => {
    const parentUpdates: Array<Record<string, unknown>> = [];
    const projectionUpdates: Array<Record<string, unknown>> = [];
    const projection = {
      id: 'projection-1',
      bindingId: 'binding-1',
      networkName: 'gateway-db-av-1',
      connectorName: 'gateway-db-av-connector-1',
      connectorAlias: 'db-1',
      connectorAddress: '172.18.0.1',
    };
    const binding = {
      id: 'binding-1',
      managedDatabaseId: 'database-1',
      targetType: 'deployment',
      targetResourceId: 'deployment-1',
      targetNodeId: 'node-1',
      networkName: 'gateway-db-old',
      encryptedCredentials: 'encrypted',
    };
    const selects = [[projection], [binding], [{ id: 'parent-projection' }]];
    const tx = {
      update: vi.fn((table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            if (tx.update.mock.calls[0]?.[0] === table) parentUpdates.push(values);
            else projectionUpdates.push(values);
          },
        }),
      })),
    };
    const subject = Object.create(ManagedDatabaseBindingService.prototype) as any;
    subject.db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => selects.shift() ?? [] }),
        }),
      }),
      transaction: async (callback: (writer: typeof tx) => Promise<void>) => callback(tx),
    };
    // The first projection query does not use limit.
    subject.db.select = vi
      .fn()
      .mockReturnValueOnce({ from: () => ({ where: async () => selects.shift() ?? [] }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => selects.shift() ?? [] }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => selects.shift() ?? [] }) }) });
    subject.getDatabase = vi.fn().mockResolvedValue({ id: 'database-1', nodeId: 'database-node-1', type: 'postgres' });
    subject.bindingCredentials = vi.fn().mockReturnValue({ username: 'app', password: 'secret' });
    subject.targetRuntime = {
      adoptAvailabilityPlacement: vi.fn().mockResolvedValue({ connectorAddress: '172.18.0.2' }),
      cleanupSupersededRuntime: vi.fn().mockResolvedValue(undefined),
    };
    subject.relayPolicy = { revokeOwner: vi.fn().mockResolvedValue(undefined) };

    await subject.adoptAvailabilityPlacementAsSingle({
      placementId: 'placement-1',
      generation: 7,
      nodeId: 'node-2',
      resource: { kind: 'deployment', resourceId: 'deployment-1', displayName: 'api' },
    });

    expect(subject.targetRuntime.adoptAvailabilityPlacement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'binding-1',
        targetNodeId: 'node-2',
        targetResourceId: 'deployment-1',
        networkName: 'gateway-db-av-1',
      }),
      'projection-1',
      expect.anything(),
      ['deployment:deployment-1']
    );
    expect(subject.targetRuntime.cleanupSupersededRuntime).not.toHaveBeenCalled();
    expect(parentUpdates).toContainEqual(
      expect.objectContaining({ targetNodeId: 'node-2', targetResourceId: 'deployment-1', status: 'ready' })
    );
    expect(projectionUpdates).toContainEqual(
      expect.objectContaining({ availabilityPlacementId: null, generation: 7, status: 'ready' })
    );
  });
});
