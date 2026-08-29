import { describe, expect, it, vi } from 'vitest';
import { relayEndpoints, relayGrantSigningKeys, relayPolicyState, relayRoutes } from '@/db/schema/index.js';
import { managedDatabaseListenerConfigsEqual, RelayPolicyService } from './relay-policy.service.js';

function createService(
  db: unknown,
  relay: {
    applySnapshot: ReturnType<typeof vi.fn>;
    getRouteRuntime?: ReturnType<typeof vi.fn>;
  }
) {
  return new RelayPolicyService(
    db as never,
    {} as never,
    {
      getConfig: vi.fn().mockResolvedValue({
        relayGrantTtlHours: 4,
        relay: {
          dataLanes: 4,
          readChunkBytes: 32 * 1024,
          adaptiveAdmissionEnabled: true,
          proxyTargetPressurePercent: 70,
          databaseReservePercent: 20,
          hardPressurePercent: 95,
        },
      }),
    } as never,
    relay as never
  );
}

describe('managed database listener equality', () => {
  it('treats JSONB key and source ordering as semantically unchanged', () => {
    const persisted = {
      listenPort: 8123,
      networkName: 'gateway-db-binding',
      listenAddress: '172.28.0.1',
      allowedSources: ['container:worker', 'container:api'],
    };
    const desired = {
      networkName: 'gateway-db-binding',
      listenAddress: '172.28.0.1',
      listenPort: 8123,
      allowedSources: ['container:api', 'container:worker'],
    };

    expect(managedDatabaseListenerConfigsEqual(persisted, desired)).toBe(true);
  });

  it('detects a listener routing change', () => {
    const current = {
      networkName: 'gateway-db-binding',
      listenAddress: '172.28.0.1',
      listenPort: 5432,
      allowedSources: ['container:api'],
    };

    expect(managedDatabaseListenerConfigsEqual(current, { ...current, listenPort: 6379 })).toBe(false);
    expect(managedDatabaseListenerConfigsEqual(current, { ...current, allowedSources: ['container:other'] })).toBe(
      false
    );
  });
});

describe('RelayPolicyService route runtime', () => {
  it('reads managed database binding runtime from its owned Relay route', async () => {
    const limit = vi.fn().mockResolvedValue([{ id: 'route-binding-1' }]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) };
    const getRouteRuntime = vi.fn().mockResolvedValue({
      routeId: 'route-binding-1',
      activeTunnels: '3',
      openedTotal: '9',
      completedTotal: '7',
      failedTotal: '1',
      throttledTotal: '2',
      sourceToTargetBytes: '1024',
      targetToSourceBytes: '2048',
      setupLatencyP95Microseconds: '12500',
      averageDurationMilliseconds: '350',
      lastActivityUnixMilliseconds: '1787932800000',
      metricsSinceUnixMilliseconds: '1787929200000',
    });
    const service = createService(db, { applySnapshot: vi.fn(), getRouteRuntime });

    await expect(service.getManagedDatabaseBindingRouteRuntime('binding-1')).resolves.toEqual({
      routeId: 'route-binding-1',
      activeStreams: 3,
      openedTotal: '9',
      completedTotal: '7',
      failedTotal: '1',
      throttledTotal: '2',
      sourceToTargetBytes: '1024',
      targetToSourceBytes: '2048',
      setupLatencyP95Ms: 12.5,
      averageDurationMs: 350,
      lastActivityAt: '2026-08-28T16:00:00.000Z',
      metricsSince: '2026-08-28T15:00:00.000Z',
    });
    expect(getRouteRuntime).toHaveBeenCalledWith('route-binding-1');
  });
});

describe('RelayPolicyService snapshots', () => {
  it('reads the complete snapshot in one read-only repeatable-read transaction', async () => {
    const rows = new Map<unknown, unknown[]>([
      [relayPolicyState, [{ revision: 7, gatewayInstanceId: 'gateway-1' }]],
      [relayGrantSigningKeys, [{ keyId: 'key-1', publicKey: Buffer.alloc(32, 1).toString('base64') }]],
      [
        relayEndpoints,
        [
          {
            id: 'endpoint-1',
            generation: 3,
            status: 'active',
            subjectKind: 'daemon',
            subjectId: 'node-target',
            certificateSha256: `sha256:${'a'.repeat(64)}`,
            maxConcurrentSessions: 8,
          },
        ],
      ],
      [
        relayRoutes,
        [
          {
            id: 'route-1',
            ownerKind: 'managed_database_binding',
            generation: 4,
            sourceKind: 'daemon',
            sourceId: 'node-source',
            sourceCertificateSha256: `sha256:${'b'.repeat(64)}`,
            targetEndpointId: 'endpoint-1',
            maxConcurrentSessions: 6,
            maxFrameBytes: 1024,
          },
          {
            id: 'route-2',
            ownerKind: 'proxy_host_secure_link',
            generation: 1,
            sourceKind: 'daemon',
            sourceId: 'node-source',
            sourceCertificateSha256: `sha256:${'b'.repeat(64)}`,
            targetEndpointId: 'endpoint-1',
            maxConcurrentSessions: 6,
            maxFrameBytes: 1024,
          },
        ],
      ],
    ]);
    const tx = {
      select: vi.fn(() => ({
        from: (table: unknown) => {
          const selected = rows.get(table) ?? [];
          if (table === relayPolicyState) {
            return { where: () => ({ limit: (limit: number) => Promise.resolve(selected.slice(0, limit)) }) };
          }
          if (table === relayGrantSigningKeys) {
            return { where: () => Promise.resolve(selected) };
          }
          return Promise.resolve(selected);
        },
      })),
    };
    const transaction = vi.fn(async (callback: (value: typeof tx) => unknown, _config: unknown) => callback(tx));
    const db = { transaction, select: vi.fn(() => Promise.reject(new Error('read escaped transaction'))) };
    const applySnapshot = vi.fn().mockResolvedValue({ appliedRevision: '7', unchanged: false });
    const service = createService(db, { applySnapshot });

    await expect(service.syncSnapshot()).resolves.toBe(7);

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(applySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: '7',
        gatewayInstanceId: 'gateway-1',
        admissionPolicy: {
          enabled: true,
          proxyTargetPressurePercent: 70,
          databaseReservePercent: 20,
          hardPressurePercent: 95,
        },
        endpoints: [expect.objectContaining({ endpointId: 'endpoint-1', generation: '3' })],
        routes: [
          expect.objectContaining({
            routeId: 'route-1',
            generation: '4',
            disableIdleTimeout: false,
            trafficClass: 'database',
          }),
          expect.objectContaining({
            routeId: 'route-2',
            generation: '1',
            maxConcurrentSessions: 1024,
            disableIdleTimeout: true,
            trafficClass: 'proxy',
          }),
        ],
      })
    );
  });

  it('does not reissue unchanged grants on every policy reconciliation', async () => {
    const service = createService({} as never, { applySnapshot: vi.fn() });
    const issuer = (service as any).grantIssuer;
    issuer.requireState = vi.fn().mockResolvedValue({ revision: 7 });
    issuer.policyNodeIds = vi.fn().mockResolvedValue([]);

    await service.refreshAllNodeGrantsIfDue();
    await service.refreshAllNodeGrantsIfDue();

    expect(issuer.policyNodeIds).toHaveBeenCalledOnce();
  });

  it('serializes grant bundle generation and dispatch per node', async () => {
    const service = createService({} as never, { applySnapshot: vi.fn() });
    let releaseFirst!: () => void;
    const firstDispatch = new Promise<{ success: true }>((resolve) => {
      releaseFirst = () => resolve({ success: true });
    });
    const sendRelayGrantBundle = vi.fn().mockReturnValueOnce(firstDispatch).mockResolvedValueOnce({ success: true });
    service.setNodeDispatch({ sendRelayGrantBundle } as never);
    const bundles = vi
      .spyOn(service, 'getNodeGrantBundle')
      .mockResolvedValueOnce({ revision: '7', generatedAtUnixMs: '100', grants: [] })
      .mockResolvedValueOnce({ revision: '7', generatedAtUnixMs: '101', grants: [] });

    const first = service.syncNodeGrantBundle('node-1');
    await vi.waitFor(() => expect(sendRelayGrantBundle).toHaveBeenCalledOnce());
    const second = service.syncNodeGrantBundle('node-1');
    await Promise.resolve();

    expect(bundles).toHaveBeenCalledOnce();
    releaseFirst();
    await Promise.all([first, second]);
    expect(sendRelayGrantBundle.mock.calls.map((call) => call[1].generatedAtUnixMs)).toEqual(['100', '101']);
  });

  it('probes the managed database source route before declaring the binding usable', async () => {
    const service = createService({} as never, { applySnapshot: vi.fn() });
    const sendRelayGrantBundle = vi.fn().mockResolvedValue({ success: true });
    const probeRelayCandidate = vi.fn().mockResolvedValue({ success: true });
    service.setNodeDispatch({ sendRelayGrantBundle, probeRelayCandidate } as never);
    const candidate = { relayInstanceId: 'relay-1', assignmentGeneration: '3' } as any;
    const getNodeGrantBundle = vi.spyOn(service, 'getNodeGrantBundle').mockResolvedValue({
      revision: '7',
      generatedAtUnixMs: '100',
      grants: [
        {
          role: 'connect',
          ownerKind: 'managed_database_binding',
          ownerId: '11111111-1111-4111-8111-111111111111',
          routeId: 'route-1',
          targetEndpointId: 'endpoint-1',
          grant: 'signed-grant',
          candidates: [candidate],
        },
      ],
    } as any);

    await service.syncNodeGrantBundle('node-1');
    await service.probeManagedDatabaseBindingRoute('node-1', '11111111-1111-4111-8111-111111111111');

    expect(getNodeGrantBundle).toHaveBeenCalledOnce();
    expect(probeRelayCandidate).toHaveBeenCalledWith('node-1', {
      probeId: '11111111-1111-4111-8111-111111111111',
      role: 'source',
      endpointId: 'endpoint-1',
      routeId: 'route-1',
      assignmentGeneration: '3',
      candidate,
    });
  });

  it('checks Relay Pool support without treating the internal registry local service as a node', async () => {
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ nodeId: 'gateway-internal-registry', subjectKind: 'local_service' }]),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => Promise.resolve([{ sourceKind: 'daemon', sourceId: '11111111-1111-4111-8111-111111111111' }]),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () =>
            Promise.resolve([
              {
                id: '11111111-1111-4111-8111-111111111111',
                capabilities: { capabilities: ['relay_pool_v1'] },
              },
            ]),
        }),
      });
    const service = createService({ select } as never, { applySnapshot: vi.fn() });

    await expect((service as any).grantIssuer.endpointPathSupportsPool('endpoint-1')).resolves.toBe(true);
  });

  it('keeps a persisted owner revocation when the runtime snapshot must be deferred', async () => {
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: () => ({
          where: () => Promise.resolve([{ nodeId: 'source-node', sourceKind: 'daemon' }]),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({ where: () => Promise.resolve([{ nodeId: 'target-node' }]) }),
      });
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const tx = {
      delete: vi.fn(() => ({
        where: () => ({ returning: () => Promise.resolve([{ id: 'deleted' }]) }),
      })),
      update: vi.fn(() => ({ set: () => ({ where: updateWhere }) })),
    };
    const db = {
      select,
      transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const service = createService(db, { applySnapshot: vi.fn() });
    vi.spyOn(service, 'syncSnapshot').mockRejectedValue(new Error('relay unavailable'));
    vi.spyOn(service as any, 'syncNodeGrants').mockResolvedValue(undefined);
    (service as any).grantIssuer.policyNodeIds = vi.fn().mockResolvedValue([]);

    await expect(
      service.revokeOwner('proxy_host_secure_link', 'proxy-1', { allowDeferredSnapshot: true })
    ).resolves.toBeUndefined();

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(tx.delete).toHaveBeenCalledTimes(2);
    expect(updateWhere).toHaveBeenCalledOnce();
  });
});

describe('RelayPolicyService lifecycle events', () => {
  it('bumps and reapplies the relay snapshot when persisted relay settings change', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const where = vi.fn().mockResolvedValue(undefined);
    const tx = { update: vi.fn(() => ({ set: vi.fn(() => ({ where })) })) };
    const db = { transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)) };
    const service = createService(db, { applySnapshot: vi.fn() });
    const syncSnapshot = vi.spyOn(service, 'syncSnapshot').mockResolvedValue(8);
    const refresh = vi.spyOn(service, 'refreshAllNodeGrantsIfDue').mockResolvedValue(undefined);
    service.setEventBus({
      subscribe: vi.fn((channel: string, handler: (payload: unknown) => void) => handlers.set(channel, handler)),
    } as never);

    handlers.get('system.config.changed')!({ relayChanged: true });
    await (service as any).relaySettingsSync;

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(syncSnapshot).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(true);
  });

  it('ignores binding events on the shared database channel', () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const service = createService({ transaction: vi.fn(), select: vi.fn() }, { applySnapshot: vi.fn() });
    const updateStatus = vi.spyOn(service as any, 'updateManagedDatabaseStatus').mockResolvedValue(undefined);
    const revokeOwner = vi.spyOn(service, 'revokeOwner').mockResolvedValue(undefined);
    service.setEventBus({
      subscribe: vi.fn((channel: string, handler: (payload: unknown) => void) => handlers.set(channel, handler)),
    } as never);

    const databaseChanged = handlers.get('database.changed')!;
    databaseChanged({
      resourceKind: 'managed_database_binding',
      managedDatabaseId: 'database-1',
      bindingId: 'binding-1',
      action: 'binding.ready',
      status: 'ready',
    });
    databaseChanged({
      resourceKind: 'managed_database_binding',
      managedDatabaseId: 'database-1',
      bindingId: 'binding-1',
      action: 'binding.deleted',
      status: 'deleting',
    });

    expect(updateStatus).not.toHaveBeenCalled();
    expect(revokeOwner).not.toHaveBeenCalled();
  });

  it('continues to apply managed database lifecycle events', () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const service = createService({ transaction: vi.fn(), select: vi.fn() }, { applySnapshot: vi.fn() });
    const updateStatus = vi.spyOn(service as any, 'updateManagedDatabaseStatus').mockResolvedValue(undefined);
    service.setEventBus({
      subscribe: vi.fn((channel: string, handler: (payload: unknown) => void) => handlers.set(channel, handler)),
    } as never);

    handlers.get('database.changed')!({
      resourceKind: 'managed_database',
      managedDatabaseId: 'database-1',
      action: 'ready',
      status: 'ready',
    });

    expect(updateStatus).toHaveBeenCalledWith('database-1', 'ready');
  });
});

describe('RelayPolicyService gateway tunnels', () => {
  it.each(['error', 'deleting', 'stopped'])('does not reactivate a database in %s status', async (status) => {
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ nodeId: 'node-target', status }]) }),
        }),
      })),
    };
    const service = createService(db, { applySnapshot: vi.fn() });
    const ensureRoute = vi.spyOn(service, 'ensureGatewayRoute');

    await expect(service.openGatewayTunnel('database-1', `sha256:${'a'.repeat(64)}`)).rejects.toThrow(
      'Managed database is unavailable'
    );
    expect(ensureRoute).not.toHaveBeenCalled();
  });

  it('leaves an inactive endpoint under lifecycle reconciliation ownership', async () => {
    const update = vi.fn();
    const tx = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  id: 'endpoint-1',
                  subjectId: 'node-target',
                  certificateSha256: `sha256:${'a'.repeat(64)}`,
                  status: 'inactive',
                },
              ]),
          }),
        }),
      })),
      update,
    };
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ nodeId: 'node-target', status: 'ready' }]) }),
        }),
      })),
      transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const service = createService(db, { applySnapshot: vi.fn() });
    vi.spyOn((service as any).grantIssuer, 'requireNodeIdentity').mockResolvedValue({
      certificateFingerprint: `sha256:${'a'.repeat(64)}`,
    });

    await expect(service.ensureManagedDatabaseEndpoint('database-1', 'node-target')).rejects.toThrow(
      'awaiting lifecycle reconciliation'
    );
    expect(update).not.toHaveBeenCalled();
  });
});
