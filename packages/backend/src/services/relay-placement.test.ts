import { describe, expect, it, vi } from 'vitest';
import { AVAILABILITY_LEASE_CAPABILITY } from '@/modules/docker/availability/lease/lease-constants.js';
import { planRelays, RelayPoolService } from './relay-pool.service.js';
import { chooseByRendezvous, includeRemoteRelay } from './relay-topology.js';

const ENDPOINT = '20000000-0000-4000-8000-000000000001';

function relay(id: string, options: { kind?: 'local' | 'remote'; state?: string; lease?: boolean } = {}) {
  return {
    id,
    kind: options.kind ?? 'remote',
    faultDomainId: `domain-${id}`,
    state: options.state ?? 'ready',
    health: { pressurePercent: 0 },
    capabilities: { features: ['relay_pool_v1', ...(options.lease === false ? [] : [AVAILABILITY_LEASE_CAPABILITY])] },
  } as any;
}

const local = relay('00000000-0000-4000-8000-000000000001', { kind: 'local' });
const relay136 = relay('54fa7622-0000-4000-8000-000000000136');
const relay137 = relay('31270786-0000-4000-8000-000000000137');

function ids(planned: ReturnType<typeof planRelays>) {
  return planned.map(({ instance }) => instance.id).sort();
}

describe('relay placement of Availability members (D7, stand run c)', () => {
  it('puts a member endpoint on every ready lease relay, dormant standbys included', () => {
    const pool = [local, relay136, relay137];
    // The configured spread (one or two relays) does not apply to members.
    expect(ids(planRelays(ENDPOINT, pool, 1, false, undefined, [], true))).toEqual(pool.map(({ id }) => id).sort());
    expect(planRelays(ENDPOINT, pool, 2, false, undefined, [], true)).toHaveLength(3);
  });

  it('leaves out relays that are not ready or do not run the lease protocol', () => {
    const offline = relay('offline-relay', { state: 'offline' });
    const old = relay('old-relay', { lease: false });
    expect(ids(planRelays(ENDPOINT, [local, relay136, offline, old], 1, false, undefined, [], true))).toEqual(
      [local.id, relay136.id].sort()
    );
  });

  it('places a member like any other endpoint while no ready relay runs the lease protocol', () => {
    const pool = [relay('local-old', { kind: 'local', lease: false }), relay('remote-old', { lease: false })];
    const planned = planRelays(ENDPOINT, pool, 1, false, undefined, [], true);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.instance.id).toBe('remote-old');
  });

  it('keeps an endpoint with a daemon lacking Relay Pool support on the local relay', () => {
    expect(ids(planRelays(ENDPOINT, [local, relay136], 2, true, undefined, [], true))).toEqual([local.id]);
  });
});

describe('relay placement of other endpoints: at least one relay off the Gateway host', () => {
  it('moves a single local placement to a ready remote relay, keeping the redundancy and role', () => {
    const moved = includeRemoteRelay(ENDPOINT, [{ instance: local, role: 'active' }], [local, relay136, relay137]);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.instance.kind).toBe('remote');
    expect(moved[0]!.role).toBe('active');
    expect(moved[0]!.instance.id).toBe(chooseByRendezvous(ENDPOINT, [relay136, relay137], 1)[0]!.id);
    const primary = includeRemoteRelay(ENDPOINT, [{ instance: local, role: 'primary' }], [local, relay136]);
    expect(primary).toEqual([{ instance: relay136, role: 'primary' }]);
  });

  it('keeps a placement that already has a remote relay, and the local relay alone when no remote is ready', () => {
    const mixed = [
      { instance: local, role: 'active' as const },
      { instance: relay136, role: 'active' as const },
    ];
    expect(includeRemoteRelay(ENDPOINT, mixed, [local, relay136, relay137])).toBe(mixed);
    const alone = [{ instance: local, role: 'active' as const }];
    expect(includeRemoteRelay(ENDPOINT, alone, [local, relay('down', { state: 'offline' })])).toBe(alone);
  });

  it('plans a remote relay into every configured spread whenever one is ready', () => {
    for (let index = 0; index < 32; index += 1) {
      const endpointId = `20000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`;
      for (const count of [1, 2]) {
        const planned = planRelays(endpointId, [local, relay136, relay137], count, false, undefined, []);
        expect(planned).toHaveLength(count);
        expect(planned.some(({ instance }) => instance.kind === 'remote')).toBe(true);
      }
    }
  });
});

describe('RelayPoolService availability member lookup', () => {
  it('finds member endpoints by their Secure Link and skips owners that are not links', async () => {
    const memberLink = '30000000-0000-4000-8000-000000000001';
    const otherLink = '30000000-0000-4000-8000-000000000002';
    const where = vi.fn().mockResolvedValue([{ id: memberLink }]);
    const db: any = { select: vi.fn(() => ({ from: () => ({ where }) })) };
    const pool = new RelayPoolService(db, {} as any, { publish: vi.fn() } as any, {} as any, {} as any);
    const members = await (pool as any).availabilityMemberEndpointIds([
      { id: 'endpoint-member', ownerKind: 'proxy_host_secure_link', ownerId: memberLink },
      { id: 'endpoint-other', ownerKind: 'proxy_host_secure_link', ownerId: otherLink },
      { id: 'endpoint-db', ownerKind: 'managed_database', ownerId: memberLink },
      { id: 'endpoint-registry', ownerKind: 'proxy_host_secure_link', ownerId: 'gateway-internal-registry' },
    ]);
    expect([...members]).toEqual(['endpoint-member']);
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(
      await (pool as any).availabilityMemberEndpointIds([{ id: 'db', ownerKind: 'managed_database', ownerId: 'x' }])
    ).toEqual(new Set());
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
