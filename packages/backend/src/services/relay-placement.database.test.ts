import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { AVAILABILITY_LEASE_CAPABILITY } from '@/modules/docker/availability/lease/lease-constants.js';
import { RelayPolicyService } from './relay-policy.service.js';
import { RelayPoolService } from './relay-pool.service.js';
import { RelayTopologyService } from './relay-topology.service.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): relay placement against a real PostgreSQL, from the assignments the
 * rc.20 stand ended with (stand run c, B-4): Availability members and other Secure Links on the local relay alone.
 * After the upgrade the pool plans members onto every lease relay and every other link onto a remote relay, and
 * automatic rebalancing picks that up by itself; once applied the pool is healthy (N-1).
 */
describe.skipIf(!url)('relay placement on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let service: RelayPoolService;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let localRelay = '';
  const relay136 = randomUUID();
  const relay137 = randomUUID();
  const oldRelay = randomUUID();
  const nodeId = randomUUID();
  const isolatedNodeId = randomUUID();
  let memberEndpoint = '';
  let plainEndpoint = '';
  let isolatedEndpoint = '';
  let db: DrizzleClient;
  let hostId = '';
  let placementId = '';
  let incapable = new Set<string>();

  /** A node's health report with the round trips it measured (ms by relay id). */
  async function reportLatencies(node: string, rtts: Record<string, number>) {
    await q(`update nodes set last_seen_at = now(), last_health_report = $2 where id = $1`, [
      node,
      JSON.stringify({
        relayLatencies: Object.entries(rtts).map(([relayInstanceId, rttMs]) => ({ relayInstanceId, rttMs })),
      }),
    ]);
  }

  async function memberLink(): Promise<string> {
    const linkId = randomUUID();
    await q(
      `insert into proxy_additional_secure_links (id, proxy_host_id, name, purpose, reference_id,
         availability_owner_key, upstream_kind, source_node_id, docker_node_id, docker_container_port,
         docker_host_port, target_container, status, dormant)
       values ($1, $2, $3, 'availability_member', $4, $5, 'docker_container', $6, $6, 80, 8080, 'app', 'active',
         true)`,
      [linkId, hostId, `m-${linkId.slice(0, 8)}`, placementId, `proxy-host:${hostId}:${linkId}`, nodeId]
    );
    return linkId;
  }

  async function endpointOnLocalRelay(ownerId: string, subject = nodeId): Promise<string> {
    const [endpoint] = (
      await q(
        `insert into relay_endpoints (owner_kind, owner_id, subject_kind, subject_id, certificate_sha256)
         values ('proxy_host_secure_link', $1, 'daemon', $2, 'sha256:x') returning id`,
        [ownerId, subject]
      )
    ).rows;
    const [generation] = (
      await q(
        `insert into relay_endpoint_assignment_generations (endpoint_id, generation, state, desired_redundancy)
         values ($1, 1, 'active', 1) returning id`,
        [endpoint.id]
      )
    ).rows;
    await q(
      `insert into relay_endpoint_assignments (assignment_generation_id, relay_instance_id, role,
         target_registration_state) values ($1, $2, 'active', 'ready')`,
      [generation.id, localRelay]
    );
    return endpoint.id;
  }

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'relay_placement');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    await q(`insert into relay_pools (id) values ('system') on conflict do nothing`);
    // Migrations seed the pool's one local relay.
    const [seeded] = (await q(`select id from relay_instances where pool_id = 'system' and kind = 'local'`)).rows;
    localRelay = seeded?.id ?? randomUUID();
    if (seeded) {
      await q(`update relay_instances set state = 'ready', capabilities = $2 where id = $1`, [
        localRelay,
        JSON.stringify({ protocolMajor: 1, features: ['relay_pool_v1', AVAILABILITY_LEASE_CAPABILITY] }),
      ]);
    }
    for (const [id, kind, features] of [
      ...(seeded ? [] : ([[localRelay, 'local', ['relay_pool_v1', AVAILABILITY_LEASE_CAPABILITY]]] as const)),
      [relay136, 'remote', ['relay_pool_v1', AVAILABILITY_LEASE_CAPABILITY]],
      [relay137, 'remote', ['relay_pool_v1', AVAILABILITY_LEASE_CAPABILITY]],
      [oldRelay, 'remote', ['relay_pool_v1']],
    ] as const) {
      await q(
        `insert into relay_instances (id, pool_id, kind, fault_domain_id, display_name, state, capabilities,
           certificate_identity, certificate_fingerprint)
         values ($1, 'system', $2, gen_random_uuid(), $4, 'ready', $3, $5, $6)`,
        [
          id,
          kind,
          JSON.stringify({ protocolMajor: 1, features }),
          `relay-${id}`,
          kind === 'remote' ? `relay-${id}` : null,
          kind === 'remote' ? `sha256:${id}` : null,
        ]
      );
    }
    for (const [id, name] of [
      [nodeId, 'app-node-1'],
      [isolatedNodeId, 'isolated-node'],
    ]) {
      await q(
        `insert into nodes (id, type, hostname, slug, status, host_identity_id) values ($1, 'docker', $2, $2,
           'online', gen_random_uuid())`,
        [id, name]
      );
    }
    // app-node-1 reaches every relay; isolated-node reaches only the Gateway host (its local relay).
    await reportLatencies(nodeId, { [localRelay]: 0.4, [relay136]: 3, [relay137]: 4, [oldRelay]: 5 });
    await reportLatencies(isolatedNodeId, { [localRelay]: 0.4 });
    const group = randomUUID();
    const user = randomUUID();
    await q('insert into permission_groups (id, name) values ($1, $2)', [group, `placement-${group}`]);
    await q("insert into users (id, group_id, email, name) values ($1, $2, $3, 'Placement')", [
      user,
      group,
      `${user}@p.test`,
    ]);
    hostId = randomUUID();
    await q(`insert into proxy_hosts (id, slug, created_by_id) values ($1, 'placement-host', $2)`, [hostId, user]);
    const policyId = randomUUID();
    await q(
      `insert into docker_availability_policies (id, resource_kind, source_node_id, container_name, mode,
         desired_replica_count, status) values ($1, 'container', $2, 'app', 'failover', 1, 'healthy')`,
      [policyId, nodeId]
    );
    const [placement] = (
      await q(
        `insert into docker_availability_placements (policy_id, node_id, generation, desired_state, actual_state,
           serving, spec_fingerprint) values ($1, $2, 1, 'standby', 'ready', false, 'spec') returning id`,
        [policyId, nodeId]
      )
    ).rows;
    placementId = placement.id;
    memberEndpoint = await endpointOnLocalRelay(await memberLink());
    plainEndpoint = await endpointOnLocalRelay(hostId);
    isolatedEndpoint = await endpointOnLocalRelay(randomUUID(), isolatedNodeId);
    service = new RelayPoolService(
      db,
      {
        describePolicyTrust: vi.fn(async () => new Map()),
        poolIncapableEndpointIds: vi.fn(async (ids: string[]) => new Set(ids.filter((id) => incapable.has(id)))),
      } as never,
      { publish: vi.fn() } as never,
      { log: vi.fn() } as never,
      { getConfig: vi.fn(async () => ({ relay: { assignmentSpread: { mode: 'fixed', count: 1 } } })) } as never
    );
    service.setTopology(new RelayTopologyService(db));
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('plans members onto every lease relay and other links off the Gateway host, and rebalances them', async () => {
    const snapshot = await service.getSnapshot();
    expect(snapshot.state).toBe('rebalance_available');
    // The isolated node's link stays on the relay that works (at most its role follows the latency data):
    // no move to a relay it cannot reach, which would only fail its probes.
    expect(snapshot.rebalanceEndpointIds).toEqual(expect.arrayContaining([memberEndpoint, plainEndpoint]));
    expect(snapshot.warnings).toEqual([
      {
        code: 'gateway_host_only',
        endpointId: isolatedEndpoint,
        ownerKind: 'proxy_host_secure_link',
        ownerId: expect.any(String),
        nodeId: isolatedNodeId,
        message:
          'No relay off the Gateway host is reachable from isolated-node: traffic of this link depends on the Gateway host.',
      },
    ]);
    const planned = (service as any).plannedRoles as Map<string, Array<{ relayInstanceId: string; role: string }>>;
    expect(
      planned
        .get(memberEndpoint)!
        .map(({ relayInstanceId }) => relayInstanceId)
        .sort()
    ).toEqual([localRelay, relay136, relay137].sort());
    const plain = planned.get(plainEndpoint)!;
    expect(plain).toHaveLength(1);
    // The nearest relay off the Gateway host that app-node-1 reaches.
    expect(plain[0]!.relayInstanceId).toBe(relay136);
    expect(planned.get(isolatedEndpoint)!.map(({ relayInstanceId }) => relayInstanceId)).toEqual([localRelay]);
  });

  it('reports a healthy pool once the planned assignments are active (N-1)', async () => {
    const planned = (service as any).plannedRoles as Map<string, Array<{ relayInstanceId: string; role: string }>>;
    for (const endpointId of [memberEndpoint, plainEndpoint, isolatedEndpoint]) {
      await q(`update relay_endpoint_assignment_generations set state = 'retired' where endpoint_id = $1`, [
        endpointId,
      ]);
      const [generation] = (
        await q(
          `insert into relay_endpoint_assignment_generations (endpoint_id, generation, state, desired_redundancy)
           values ($1, 2, 'active', $2) returning id`,
          [endpointId, planned.get(endpointId)!.length]
        )
      ).rows;
      for (const { relayInstanceId, role } of planned.get(endpointId)!) {
        await q(
          `insert into relay_endpoint_assignments (assignment_generation_id, relay_instance_id, role,
             target_registration_state) values ($1, $2, $3, 'ready')`,
          [generation.id, relayInstanceId, role]
        );
      }
    }
    const snapshot = await service.getSnapshot();
    expect(snapshot.rebalanceEndpointIds).toEqual([]);
    // Healthy, with the isolated link named as a warning rather than a degraded pool.
    expect(snapshot.state).toBe('healthy');
    expect(snapshot.warnings.map(({ endpointId }) => endpointId)).toEqual([isolatedEndpoint]);
  });

  it('starts a new member link on every lease relay, and only a legacy path on the local relay', async () => {
    const policy = new RelayPolicyService(db, {} as never, {} as never, {} as never);
    policy.setInitialAssignmentPlanner((endpointId) => service.planInitialAssignment(endpointId));
    const assigned = async (endpointId: string) =>
      (
        await q(
          `select a.relay_instance_id as relay, a.target_registration_state as state, g.generation, g.desired_redundancy
             from relay_endpoint_assignments a join relay_endpoint_assignment_generations g
               on g.id = a.assignment_generation_id
            where g.endpoint_id = $1 and g.state = 'active' order by a.relay_instance_id`,
          [endpointId]
        )
      ).rows;
    const create = async (ownerId: string) =>
      (
        await q(
          `insert into relay_endpoints (owner_kind, owner_id, subject_kind, subject_id, certificate_sha256)
           values ('proxy_host_secure_link', $1, 'daemon', $2, 'sha256:x') returning id`,
          [ownerId, nodeId]
        )
      ).rows[0].id as string;

    const fresh = await create(await memberLink());
    await (policy as any).ensureLegacyCompatibleAssignment(fresh);
    const rows = await assigned(fresh);
    expect(rows.map(({ relay }) => relay)).toEqual([localRelay, relay136, relay137].sort());
    expect(
      rows.every(
        ({ state, generation, desired_redundancy }) =>
          state === 'ready' && Number(generation) === 1 && desired_redundancy === 3
      )
    ).toBe(true);
    // The pool plans exactly that placement: no staged move follows.
    const snapshot = await service.getSnapshot();
    expect(snapshot.rebalanceEndpointIds).not.toContain(fresh);
    // Repeated calls keep the first assignment.
    await (policy as any).ensureLegacyCompatibleAssignment(fresh);
    expect(await assigned(fresh)).toEqual(rows);

    // A daemon on the path without Relay Pool support needs the legacy shape.
    const legacy = await create(await memberLink());
    incapable = new Set([legacy]);
    await (policy as any).ensureLegacyCompatibleAssignment(legacy);
    expect((await assigned(legacy)).map(({ relay }) => relay)).toEqual([localRelay]);
    // So does any link that is not an Availability member: it moves by a probed rebalance.
    const plainLink = await create(randomUUID());
    await (policy as any).ensureLegacyCompatibleAssignment(plainLink);
    expect((await assigned(plainLink)).map(({ relay }) => relay)).toEqual([localRelay]);
  });
});
