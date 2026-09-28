import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { AVAILABILITY_LEASE_CAPABILITY } from '@/modules/docker/availability/lease/lease-constants.js';
import { RelayPoolService } from './relay-pool.service.js';

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
  const localRelay = randomUUID();
  const relay136 = randomUUID();
  const relay137 = randomUUID();
  const oldRelay = randomUUID();
  const nodeId = randomUUID();
  let memberEndpoint = '';
  let plainEndpoint = '';

  async function endpointOnLocalRelay(ownerId: string): Promise<string> {
    const [endpoint] = (
      await q(
        `insert into relay_endpoints (owner_kind, owner_id, subject_kind, subject_id, certificate_sha256)
         values ('proxy_host_secure_link', $1, 'daemon', $2, 'sha256:x') returning id`,
        [ownerId, nodeId]
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
    const db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    await q(`insert into relay_pools (id) values ('system') on conflict do nothing`);
    for (const [id, kind, features] of [
      [localRelay, 'local', ['relay_pool_v1', AVAILABILITY_LEASE_CAPABILITY]],
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
    await q(
      `insert into nodes (id, type, hostname, slug, status, host_identity_id) values ($1, 'docker', 'app-node-1',
         'app-node-1', 'online', gen_random_uuid())`,
      [nodeId]
    );
    const group = randomUUID();
    const user = randomUUID();
    await q('insert into permission_groups (id, name) values ($1, $2)', [group, `placement-${group}`]);
    await q("insert into users (id, group_id, email, name) values ($1, $2, $3, 'Placement')", [
      user,
      group,
      `${user}@p.test`,
    ]);
    const hostId = randomUUID();
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
    const linkId = randomUUID();
    await q(
      `insert into proxy_additional_secure_links (id, proxy_host_id, name, purpose, reference_id,
         availability_owner_key, upstream_kind, source_node_id, docker_node_id, docker_container_port,
         docker_host_port, target_container, status, dormant)
       values ($1, $2, 'member', 'availability_member', $3, $4, 'docker_container', $5, $5, 80, 8080, 'app',
         'active', true)`,
      [linkId, hostId, placement.id, `proxy-host:${hostId}`, nodeId]
    );
    memberEndpoint = await endpointOnLocalRelay(linkId);
    plainEndpoint = await endpointOnLocalRelay(hostId);
    service = new RelayPoolService(
      db,
      {
        describePolicyTrust: vi.fn(async () => new Map()),
        poolIncapableEndpointIds: vi.fn(async () => new Set()),
      } as never,
      { publish: vi.fn() } as never,
      { log: vi.fn() } as never,
      { getConfig: vi.fn(async () => ({ relay: { assignmentSpread: { mode: 'fixed', count: 1 } } })) } as never
    );
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('plans members onto every lease relay and other links off the Gateway host, and rebalances them', async () => {
    const snapshot = await service.getSnapshot();
    expect(snapshot.state).toBe('rebalance_available');
    expect([...snapshot.rebalanceEndpointIds].sort()).toEqual([memberEndpoint, plainEndpoint].sort());
    const planned = (service as any).plannedRoles as Map<string, Array<{ relayInstanceId: string; role: string }>>;
    expect(
      planned
        .get(memberEndpoint)!
        .map(({ relayInstanceId }) => relayInstanceId)
        .sort()
    ).toEqual([localRelay, relay136, relay137].sort());
    const plain = planned.get(plainEndpoint)!;
    expect(plain).toHaveLength(1);
    expect([relay136, relay137, oldRelay]).toContain(plain[0]!.relayInstanceId);
  });

  it('reports a healthy pool once the planned assignments are active (N-1)', async () => {
    const planned = (service as any).plannedRoles as Map<string, Array<{ relayInstanceId: string; role: string }>>;
    for (const endpointId of [memberEndpoint, plainEndpoint]) {
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
    expect(snapshot.state).toBe('healthy');
  });
});
