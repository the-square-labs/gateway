import { getTableName } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { HostingFirewallService } from './hosting-firewall.service.js';
import {
  defaultHostingFirewall,
  firewallFingerprint,
  HostingFirewallConfigSchema,
  type HostingFirewallObservation,
} from './hosting-firewall.types.js';

const id = '11111111-1111-4111-8111-111111111111';
const rule = {
  id,
  direction: 'in',
  action: 'allow',
  protocol: 'tcp',
  ports: '443',
  addresses: ['0.0.0.0/0', '::/0'],
  description: 'HTTPS',
};

describe('VM firewall contract', () => {
  it('ignores API object-key order but retains firewall rule order in fingerprints', () => {
    expect(firewallFingerprint({ enable: 1, options: { dhcp: 0, ndp: 0 } })).toBe(
      firewallFingerprint({ options: { ndp: 0, dhcp: 0 }, enable: 1 })
    );
    expect(firewallFingerprint([{ action: 'deny' }, { action: 'allow' }])).not.toBe(
      firewallFingerprint([{ action: 'allow' }, { action: 'deny' }])
    );
  });
  it('is disabled by default and retains explicit directional policies', () => {
    expect(defaultHostingFirewall()).toEqual({
      enabled: false,
      inboundPolicy: 'deny',
      outboundPolicy: 'allow',
      rules: [],
    });
  });
  it.each(['0', '65536', '100-99', '0-100', '22,443', '22;reboot'])('rejects invalid ports %s', (ports) => {
    expect(
      HostingFirewallConfigSchema.safeParse({ ...defaultHostingFirewall(), rules: [{ ...rule, ports }] }).success
    ).toBe(false);
  });
  it.each([
    'example.com',
    '999.1.1.1',
    '10.0.0.1/-1',
    '10.0.0.0/33',
    '::/129',
    '::/1/2',
    '10.0.0.0/',
  ])('rejects invalid address %s', (address) => {
    expect(
      HostingFirewallConfigSchema.safeParse({ ...defaultHostingFirewall(), rules: [{ ...rule, addresses: [address] }] })
        .success
    ).toBe(false);
  });
  it('accepts IPv4/IPv6 hosts, CIDRs and ranges without hostname or shell interpretation', () => {
    expect(
      HostingFirewallConfigSchema.parse({
        ...defaultHostingFirewall(),
        rules: [{ ...rule, ports: '100-200', addresses: ['192.0.2.1', '2001:db8::1', '::/0'] }],
      }).rules
    ).toHaveLength(1);
  });
  it('rejects duplicate IDs, ICMP ports and unknown provider properties', () => {
    for (const rules of [[rule, rule], [{ ...rule, protocol: 'icmp' }], [{ ...rule, providerId: 'foreign' }]])
      expect(HostingFirewallConfigSchema.safeParse({ ...defaultHostingFirewall(), rules }).success).toBe(false);
  });
});

function fixture() {
  let row: any = null;
  let cached: any = null;
  let lock = true;
  const user = {
    id: 'actor',
    scopes: [
      'nodes:details',
      'nodes:config:view',
      'nodes:config:edit',
      'integrations:hosting:view',
      'integrations:hosting:manage',
    ],
    isDeleted: false,
    isBlocked: false,
  };
  const connector = { id: 'connector', updatedAt: new Date('2026-09-06T00:00:00Z'), enabled: true };
  const resource = {
    id: 'resource',
    connectorId: 'connector',
    origin: 'created',
    provider: 'digitalocean',
    remoteId: '123',
    incarnation: 'original',
    missingSince: null,
    snapshot: { incarnation: 'original' },
  };
  const bound = [{ id: 'node', status: 'online' }];
  const operations: any[] = [];
  const observation: HostingFirewallObservation = {
    fingerprint: 'v1',
    enabled: false,
    matches: true,
    applying: false,
    remoteId: null,
    blockers: [],
    observedAt: new Date().toISOString(),
  };
  const firewall = { read: vi.fn(async () => ({ ...observation })), apply: vi.fn(async () => {}) };
  let beforeRequest: (() => Promise<void>) | undefined;
  const adapter = {
    firewall,
    getResource: vi.fn(async () => {
      await beforeRequest?.();
      return { ...resource.snapshot };
    }),
  };
  const query = (table: any, joined = false): any => {
    const result = () => {
      const name = getTableName(table);
      if (name === 'hosting_firewalls') return row ? [row] : [];
      if (name === 'hosting_resources') return [resource];
      if (name === 'hosting_node_bindings') return joined ? bound : [{ resourceId: resource.id, nodeId: 'node' }];
      if (name === 'hosting_operations') return operations;
      return [];
    };
    return Object.assign(Promise.resolve(result()), {
      where: () => query(table, joined),
      for: () => query(table, joined),
      limit: () => query(table, joined),
      innerJoin: () => query(table, true),
    });
  };
  const db: any = {
    select: () => ({ from: (table: any) => query(table) }),
    selectDistinct: () => {
      const chain = { from: () => chain, leftJoin: () => chain, where: async () => [{ resource }] };
      return chain;
    },
    insert: () => ({
      values: (value: any) => ({
        onConflictDoNothing: async () => {
          row ??= {
            ...value,
            revision: 0,
            status: 'loading',
            observation: null,
            error: null,
            observedAt: null,
            dispatchedAt: null,
            actorId: null,
          };
        },
      }),
    }),
    update: () => ({
      set: (patch: any) => ({
        where: () => {
          row = { ...row, ...patch };
          return Object.assign(Promise.resolve(), { returning: async () => [row] });
        },
      }),
    }),
    execute: async () => ({ rows: [{ acquired: lock }] }),
    transaction: async (work: any) => work(db),
  };
  const connectors = {
    get: vi.fn(async () => connector),
    settings: () => ({ resourceIds: [] }),
    owner: async () => user,
    changed: vi.fn(),
    adapter: vi.fn((_connector, fence) => {
      beforeRequest = fence;
      return adapter;
    }),
  };
  const snapshots = {
    get: vi.fn(async () => (cached ? { data: cached } : null)),
    replace: vi.fn(async (_kind, _id, data) => {
      cached = data;
    }),
  };
  const auth = { getUserById: vi.fn(async () => user) };
  const service = new HostingFirewallService(
    db,
    connectors as never,
    snapshots as never,
    auth as never,
    { log: vi.fn() } as never
  );
  const save = (config = defaultHostingFirewall(), overrides = {}) =>
    service.update(
      'node',
      {
        config,
        expectedRevision: row?.revision ?? 0,
        expectedFingerprint: row?.observation?.fingerprint ?? 'v1',
        acknowledgeConnectivityRisk: true,
        ...overrides,
      },
      user as never
    );
  return {
    service,
    firewall,
    adapter,
    user,
    connector,
    resource,
    bound,
    operations,
    snapshots,
    connectors,
    auth,
    observation,
    save,
    row: () => row,
    setRow: (patch: any) => {
      row = { ...row, ...patch };
    },
    setLock: (value: boolean) => {
      lock = value;
    },
  };
}

describe('firewall service admission and reconciliation', () => {
  it('GET cache miss never calls a provider, inserts config or enables filtering', async () => {
    const f = fixture();
    expect(await f.service.get('node', f.user as never)).toMatchObject({
      status: 'loading',
      config: { enabled: false },
    });
    expect(f.connectors.adapter).not.toHaveBeenCalled();
    expect(f.row()).toBeNull();
  });
  it('initial background observation is read-only and publishes disabled snapshot', async () => {
    const f = fixture();
    await f.service.reconcileDue();
    expect(f.firewall.apply).not.toHaveBeenCalled();
    expect(await f.service.get('node', f.user as never)).toMatchObject({
      revision: 0,
      status: 'ready',
      observation: { fingerprint: 'v1' },
    });
  });
  it('saving disabled rules retains them without changing provider firewall', async () => {
    const f = fixture();
    await f.service.reconcileDue();
    const config = HostingFirewallConfigSchema.parse({ ...defaultHostingFirewall(), rules: [rule] });
    expect(await f.save(config)).toMatchObject({ status: 'pending', revision: 1 });
    await f.service.reconcileDue();
    expect(f.row().config.rules).toHaveLength(1);
    expect(f.row().status).toBe('ready');
    expect(f.firewall.apply).not.toHaveBeenCalled();
  });
  it('requires explicit connectivity confirmation and checks revision', async () => {
    const f = fixture();
    await f.service.reconcileDue();
    await expect(
      f.save({ ...defaultHostingFirewall(), enabled: true }, { acknowledgeConnectivityRisk: false })
    ).rejects.toThrow('Confirm');
    await expect(f.save(undefined, { expectedRevision: 4 })).rejects.toThrow('changed');
    expect(f.row().revision).toBe(0);
  });
  it('checks action-specific blockers, preserving disabled local rules without activation rights', async () => {
    const f = fixture();
    f.observation.blockers = ['Missing activation privilege'];
    f.observation.disableBlockers = [];
    await f.service.reconcileDue();
    await expect(f.save({ ...defaultHostingFirewall(), enabled: true })).rejects.toThrow('Missing activation');
    await f.save(HostingFirewallConfigSchema.parse({ ...defaultHostingFirewall(), rules: [rule] }));
    await f.service.reconcileDue();
    expect(f.row().status).toBe('ready');
    expect(f.firewall.apply).not.toHaveBeenCalled();
    f.setRow({ observation: { ...f.observation, disableBlockers: ['Foreign policy'] } });
    await expect(f.save()).rejects.toThrow('Foreign policy');
  });
  it('does not admit a retry while the provider still reports applying after a timeout', async () => {
    const f = fixture();
    await f.service.reconcileDue();
    f.setRow({ status: 'failed', observation: { ...f.observation, applying: true } });
    await expect(f.save()).rejects.toThrow('Wait for provider');
  });
  it('rejects mutation on pending nodes, other active VM operations and unavailable locks', async () => {
    const f = fixture();
    await f.service.reconcileDue();
    f.bound[0]!.status = 'pending';
    await expect(f.save()).rejects.toThrow('provisioning');
    f.bound[0]!.status = 'online';
    f.operations.push({ id: 'destroy' });
    await expect(f.save()).rejects.toThrow('operation');
    f.operations.length = 0;
    f.setLock(false);
    await expect(f.save()).rejects.toThrow('synchronizing');
  });
  it('permits recovery of an offline VM but checks every bound role permission', async () => {
    const f = fixture();
    await f.service.reconcileDue();
    f.bound[0]!.status = 'offline';
    await expect(f.save()).resolves.toMatchObject({ status: 'pending' });
    f.user.scopes = ['nodes:details:node', 'nodes:config:view:node', 'integrations:hosting:view:connector'];
    expect(await f.service.get('node', f.user as never)).toMatchObject({ canEdit: false });
    await expect(f.save()).rejects.toMatchObject({ statusCode: 403 });
    f.bound.push({ id: 'other', status: 'online' });
    await expect(f.service.get('node', f.user as never)).rejects.toBeInstanceOf(AppError);
  });
  it('checks provider fingerprint again before dispatch and does not overwrite an external edit', async () => {
    const f = fixture();
    await f.service.reconcileDue();
    await f.save({ ...defaultHostingFirewall(), enabled: true });
    f.observation.fingerprint = 'external-edit';
    f.observation.matches = false;
    await f.service.reconcileDue();
    expect(f.row().status).toBe('failed');
    expect(f.firewall.apply).not.toHaveBeenCalled();
  });
  it('persists applying before dispatch and confirms provider convergence', async () => {
    const f = fixture();
    await f.service.reconcileDue();
    await f.save({ ...defaultHostingFirewall(), enabled: true });
    f.observation.matches = false;
    f.firewall.apply.mockImplementation(async () => {
      expect(f.row().status).toBe('applying');
      expect(f.row().dispatchedAt).toBeInstanceOf(Date);
      f.observation.matches = true;
      f.observation.enabled = true;
    });
    await f.service.reconcileDue();
    expect(f.row().status).toBe('ready');
    expect(f.firewall.apply).toHaveBeenCalledOnce();
  });
  it('never replays an interrupted dispatch and times out unconfirmed application', async () => {
    const f = fixture();
    await f.service.reconcileDue();
    await f.save({ ...defaultHostingFirewall(), enabled: true });
    f.setRow({ status: 'applying', dispatchedAt: new Date(Date.now() - 11 * 60_000) });
    f.observation.matches = false;
    await f.service.reconcileDue();
    expect(f.row().status).toBe('failed');
    expect(f.firewall.apply).not.toHaveBeenCalled();
  });
  it('does not turn unresolved failed changes into ready on the next refresh', async () => {
    const f = fixture();
    await f.service.reconcileDue();
    f.setRow({ revision: 1, status: 'failed', observedAt: null, error: 'not confirmed' });
    f.observation.matches = false;
    await f.service.reconcileDue();
    expect(f.row().status).toBe('failed');
    expect(f.row().error).toBe('not confirmed');
  });
  it('fences actor deletion, resource replacement and connector rotation before dispatch', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.user.isDeleted = true;
      },
      (f: ReturnType<typeof fixture>) => {
        f.resource.snapshot.incarnation = 'replacement';
      },
      (f: ReturnType<typeof fixture>) => {
        f.connector.updatedAt = new Date();
      },
      (f: ReturnType<typeof fixture>) => {
        f.setRow({ actorId: null });
      },
    ]) {
      const f = fixture();
      await f.service.reconcileDue();
      await f.save({ ...defaultHostingFirewall(), enabled: true });
      mutate(f);
      await f.service.reconcileDue();
      expect(f.row().status).toBe('failed');
      expect(f.firewall.apply).not.toHaveBeenCalled();
    }
  });
  it('hides stale connector snapshots after credential changes', async () => {
    const f = fixture();
    await f.service.reconcileDue();
    f.connector.updatedAt = new Date();
    expect(await f.service.get('node', f.user as never)).toMatchObject({ status: 'loading', observation: null });
  });
  it('terminates pending changes when the last node or connector is removed', async () => {
    for (const remove of [
      (f: ReturnType<typeof fixture>) => {
        f.bound.length = 0;
      },
      (f: ReturnType<typeof fixture>) => {
        (f.resource as any).connectorId = null;
      },
      (f: ReturnType<typeof fixture>) => {
        f.connectors.get.mockRejectedValue(new AppError(409, 'DISABLED', 'Connector disabled'));
      },
    ]) {
      const f = fixture();
      await f.service.reconcileDue();
      await f.save({ ...defaultHostingFirewall(), enabled: true });
      remove(f);
      await f.service.reconcileDue();
      expect(f.row().status).toBe('failed');
      expect(f.firewall.apply).not.toHaveBeenCalled();
    }
  });
});
