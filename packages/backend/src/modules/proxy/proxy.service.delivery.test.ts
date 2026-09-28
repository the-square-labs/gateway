import { describe, expect, it, vi } from 'vitest';
import { ProxyService } from './proxy.service.js';
import { IngressDeliveryError } from './proxy-ingress-delivery.js';

const GROUP = '99999999-9999-4999-8999-999999999999';

function deliveryDb() {
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: vi.fn(async () => {
          rows.push(values);
        }),
      }),
    })),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  };
  return { db, rows };
}

function service(options: { connected: string[]; failOn?: string }) {
  const { db, rows } = deliveryDb();
  const applied: Array<{ nodeId: string; config: string; version: string | null }> = [];
  const proxy = Object.assign(Object.create(ProxyService.prototype), {
    db,
    hostConfigEpochs: new Map<string, number>(),
    nodeDispatch: { isNodeConnected: (nodeId: string) => options.connected.includes(nodeId) },
    certificateDistribution: { deactivateHost: vi.fn(async () => undefined) },
    configOwnershipForHost: () => 'owner',
    resolveAccessList: vi.fn(async () => null),
    // Each member gets its own certificate replica (path and version per node).
    resolveCertPaths: vi.fn(async (host: { nodeId: string }) => ({
      preparedTls: { nodeId: host.nodeId, version: `v-${host.nodeId}` },
    })),
    buildNginxConfig: vi.fn(async (host: { id: string; nodeId: string }) => `server ${host.id} on ${host.nodeId}`),
    applyConfigToNode: vi.fn(
      async (_hostId: string, config: string, nodeId: string, prepared: { version: string } | null) => {
        if (nodeId === options.failOn) throw new Error('nginx -t failed');
        applied.push({ nodeId, config, version: prepared?.version ?? null });
      }
    ),
    removeConfigFromNode: vi.fn(async () => undefined),
  });
  return { proxy, rows, applied };
}

const host = (overrides: Record<string, unknown> = {}) =>
  ({ id: 'host-1', nodeId: 'a', ingressGroupId: GROUP, accessListId: null, ...overrides }) as never;

describe('route delivery to the members of an ingress group', () => {
  it('renders and applies the route on every connected member with that member certificate replica', async () => {
    const { proxy, rows, applied } = service({ connected: ['a', 'b'] });

    const result = await (proxy as any).deliverHost(host(), { nodeIds: ['a', 'b'] });

    expect(applied).toEqual([
      { nodeId: 'a', config: 'server host-1 on a', version: 'v-a' },
      { nodeId: 'b', config: 'server host-1 on b', version: 'v-b' },
    ]);
    expect([...result.configs.keys()]).toEqual(['a', 'b']);
    const ready = rows.filter((row) => row.status === 'ready');
    expect(ready.map((row) => [row.nodeId, row.appliedCertificateVersion])).toEqual([
      ['a', 'v-a'],
      ['b', 'v-b'],
    ]);
  });

  it('records an offline member as pending and still applies the route on the connected ones', async () => {
    const { proxy, rows, applied } = service({ connected: ['a'] });

    await (proxy as any).deliverHost(host(), { nodeIds: ['a', 'b'] });

    expect(applied.map((entry) => entry.nodeId)).toEqual(['a']);
    expect(rows).toContainEqual(expect.objectContaining({ nodeId: 'b', status: 'pending' }));
  });

  it('reports the members a route did not reach and keeps what the others applied', async () => {
    const { proxy, rows } = service({ connected: ['a', 'b'], failOn: 'b' });

    const error = await (proxy as any).deliverHost(host(), { nodeIds: ['a', 'b'] }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IngressDeliveryError);
    expect(error).toMatchObject({
      appliedNodeIds: ['a'],
      failures: [{ nodeId: 'b', message: 'nginx -t failed' }],
      code: 'INGRESS_GROUP_DELIVERY_FAILED',
    });
    expect(rows).toContainEqual(expect.objectContaining({ nodeId: 'b', status: 'failed' }));
  });

  it('refuses a route that no member could take', async () => {
    const { proxy } = service({ connected: [] });

    await expect((proxy as any).deliverHost(host(), { nodeIds: ['a', 'b'] })).rejects.toMatchObject({
      code: 'INGRESS_GROUP_UNAVAILABLE',
      details: expect.objectContaining({ offlineNodeIds: ['a', 'b'] }),
    });
  });

  it('delivers a single-node route exactly as before, without delivery rows', async () => {
    const { proxy, rows, applied } = service({ connected: [] });

    await (proxy as any).deliverHost(host({ ingressGroupId: null }));

    expect(applied).toEqual([{ nodeId: 'a', config: 'server host-1 on a', version: 'v-a' }]);
    expect(rows).toEqual([]);
  });

  it('withdraws a group route from connected members and retires every member certificate deployment', async () => {
    const { proxy } = service({ connected: ['a'] });

    await (proxy as any).withdrawHost(host(), { nodeIds: ['a', 'b'] });

    expect(proxy.removeConfigFromNode).toHaveBeenCalledTimes(1);
    expect(proxy.removeConfigFromNode).toHaveBeenCalledWith('host-1', 'a');
    expect(proxy.certificateDistribution.deactivateHost.mock.calls).toEqual([
      ['host-1', 'a'],
      ['host-1', 'b'],
    ]);
  });
});
