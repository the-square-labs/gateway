import { describe, expect, it, vi } from 'vitest';
import { relayEndpoints, relayGrantSigningKeys, relayPolicyState, relayRoutes } from '@/db/schema/index.js';
import { RelayPolicyService } from './relay-policy.service.js';

function createService(db: unknown, relay: { applySnapshot: ReturnType<typeof vi.fn> }) {
  return new RelayPolicyService(
    db as never,
    {} as never,
    { getConfig: vi.fn().mockResolvedValue({ relayGrantTtlHours: 4 }) } as never,
    relay as never
  );
}

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
        endpoints: [expect.objectContaining({ endpointId: 'endpoint-1', generation: '3' })],
        routes: [
          expect.objectContaining({ routeId: 'route-1', generation: '4', disableIdleTimeout: false }),
          expect.objectContaining({ routeId: 'route-2', generation: '1', disableIdleTimeout: true }),
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
});

describe('RelayPolicyService lifecycle events', () => {
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
