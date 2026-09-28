import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { AVAILABILITY_LEASE_CAPABILITY } from '@/modules/docker/availability/lease/lease-constants.js';
import { RelayPoolService } from './relay-pool.service.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;

const GATE_CLOSED = (node: string) =>
  `rpc error: code = FailedPrecondition desc = availability lease gate closed: ${node} holds no committed slot`;
const BUSY = 'daemon is busy handling long-running commands; retry shortly';

type Probe = (nodeId: string, input: { role: 'source' | 'target'; endpointId: string }) => Promise<void>;

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): the rc.20 main stand (B-17) kept its relay pool degraded in steady
 * state. Source probes of dormant Availability members were refused by the relays' lease gate, probes found the
 * daemon busy or its node disconnected, a Gateway restart left preparations behind, and a Secure Link re-provisioned
 * meanwhile deleted a generation under the batch. Each of these must converge to a healthy pool by itself, without
 * a failed generation.
 */
describe.skipIf(!url)('relay pool rebalance under transient conditions on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let service: RelayPoolService;
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let localRelay = '';
  const remoteRelays = [randomUUID(), randomUUID()];
  const remoteNodes = [randomUUID(), randomUUID()];
  const dockerNode = randomUUID();
  const nginxNode = randomUUID();
  let hostId = '';
  let placementId = '';
  let clock = 0;
  let probe: Probe = async () => undefined;
  const probeRelayCandidate = vi.fn((nodeId: string, input: Parameters<Probe>[1]) => probe(nodeId, input));

  /** The grants a daemon holds: every staging and active generation's candidates, per endpoint and per route. */
  async function grantBundle() {
    const assignments = (
      await q(
        `select g.endpoint_id, g.generation, a.relay_instance_id
           from relay_endpoint_assignment_generations g
           join relay_endpoint_assignments a on a.assignment_generation_id = g.id
          where g.state in ('staging', 'active')`
      )
    ).rows;
    const candidates = (endpointId: string) =>
      assignments
        .filter((row) => row.endpoint_id === endpointId)
        .map((row) => ({ relayInstanceId: row.relay_instance_id, assignmentGeneration: String(row.generation) }));
    const endpoints = (await q('select id from relay_endpoints')).rows;
    const routes = (await q('select id, target_endpoint_id from relay_routes')).rows;
    return {
      grants: [
        ...endpoints.map(({ id }) => ({ role: 'endpoint', endpointId: id, candidates: candidates(id) })),
        ...routes.map((route) => ({
          role: 'connect',
          routeId: route.id,
          candidates: candidates(route.target_endpoint_id),
        })),
      ],
    };
  }

  /** A dormant Availability member's Secure Link from the nginx node, on the local relay alone (the legacy shape). */
  async function memberEndpoint(): Promise<string> {
    const linkId = randomUUID();
    await q(
      `insert into proxy_additional_secure_links (id, proxy_host_id, name, purpose, reference_id,
         availability_owner_key, upstream_kind, source_node_id, docker_node_id, docker_container_port,
         docker_host_port, target_container, status, dormant)
       values ($1, $2, $3, 'availability_member', $4, $5, 'docker_container', $6, $7, 80, 8080, 'app', 'active', true)`,
      [linkId, hostId, `m-${linkId.slice(0, 8)}`, placementId, `proxy-host:${hostId}:${linkId}`, nginxNode, dockerNode]
    );
    const [endpoint] = (
      await q(
        `insert into relay_endpoints (owner_kind, owner_id, subject_kind, subject_id, certificate_sha256)
         values ('proxy_host_secure_link', $1, 'daemon', $2, 'sha256:docker') returning id`,
        [linkId, dockerNode]
      )
    ).rows;
    const [generation] = (
      await q(
        `insert into relay_endpoint_assignment_generations (endpoint_id, generation, state, desired_redundancy,
           activated_at) values ($1, 1, 'active', 1, now()) returning id`,
        [endpoint.id]
      )
    ).rows;
    await q(
      `insert into relay_endpoint_assignments (assignment_generation_id, relay_instance_id, role,
         target_registration_state) values ($1, $2, 'active', 'ready')`,
      [generation.id, localRelay]
    );
    await q(
      `insert into relay_routes (owner_kind, owner_id, source_kind, source_id, source_certificate_sha256,
         target_endpoint_id) values ('proxy_host_secure_link', $1, 'daemon', $2, 'sha256:nginx', $3)`,
      [linkId, nginxNode, endpoint.id]
    );
    return endpoint.id;
  }

  const generations = async (endpointId: string) =>
    (
      await q(
        `select g.generation::int, g.state, g.activated_at, g.activation_error,
                (select count(*)::int from relay_endpoint_assignments a where a.assignment_generation_id = g.id) relays
           from relay_endpoint_assignment_generations g where g.endpoint_id = $1 order by g.generation`,
        [endpointId]
      )
    ).rows;

  /** Runs the automatic loop the way its timer does, far enough apart to pass the settle time and any backoff. */
  async function automaticPass() {
    clock += 6 * 60_000;
    await service.reconcile();
    clock += 31_000;
    await service.reconcile();
  }

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'relay_pool_transient');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    await q(`insert into relay_pools (id) values ('system') on conflict do nothing`);
    const features = JSON.stringify({ protocolMajor: 1, features: ['relay_pool_v1', AVAILABILITY_LEASE_CAPABILITY] });
    const [seeded] = (await q(`select id from relay_instances where pool_id = 'system' and kind = 'local'`)).rows;
    if (seeded) {
      localRelay = seeded.id;
      await q(`update relay_instances set state = 'ready', capabilities = $2 where id = $1`, [localRelay, features]);
    } else {
      localRelay = randomUUID();
      await q(
        `insert into relay_instances (id, pool_id, kind, fault_domain_id, display_name, state, capabilities)
         values ($1, 'system', 'local', gen_random_uuid(), 'local', 'ready', $2)`,
        [localRelay, features]
      );
    }
    for (const [id, type] of [
      [remoteNodes[0], 'relay'],
      [remoteNodes[1], 'relay'],
      [dockerNode, 'docker'],
      [nginxNode, 'nginx'],
    ] as const) {
      await q(
        `insert into nodes (id, type, hostname, slug, status, host_identity_id)
         values ($1, $2, $3, $3, 'online', gen_random_uuid())`,
        [id, type, `node-${id.slice(0, 8)}`]
      );
    }
    for (const [index, id] of remoteRelays.entries()) {
      await q(
        `insert into relay_instances (id, pool_id, kind, node_id, fault_domain_id, display_name, state, capabilities,
           certificate_identity, certificate_fingerprint)
         values ($1, 'system', 'remote', $2, gen_random_uuid(), $3, 'ready', $4, $3, $5)`,
        [id, remoteNodes[index], `relay-${index}`, features, `sha256:${id}`]
      );
    }
    const group = randomUUID();
    const user = randomUUID();
    await q('insert into permission_groups (id, name) values ($1, $2)', [group, `transient-${group}`]);
    await q("insert into users (id, group_id, email, name) values ($1, $2, $3, 'Transient')", [
      user,
      group,
      `${user}@t.test`,
    ]);
    hostId = randomUUID();
    await q(`insert into proxy_hosts (id, slug, created_by_id) values ($1, 'transient-host', $2)`, [hostId, user]);
    const policyId = randomUUID();
    await q(
      `insert into docker_availability_policies (id, resource_kind, source_node_id, container_name, mode,
         desired_replica_count, status) values ($1, 'container', $2, 'app', 'failover', 1, 'healthy')`,
      [policyId, dockerNode]
    );
    placementId = (
      await q(
        `insert into docker_availability_placements (policy_id, node_id, generation, desired_state, actual_state,
           serving, spec_fingerprint) values ($1, $2, 1, 'standby', 'ready', false, 'spec') returning id`,
        [policyId, dockerNode]
      )
    ).rows[0].id;
    service = new RelayPoolService(
      db,
      {
        describePolicyTrust: vi.fn(async () => new Map()),
        poolIncapableEndpointIds: vi.fn(async () => new Set()),
        syncSnapshot: vi.fn(async () => 1),
        syncRemoteInstancePolicy: vi.fn(async () => 1),
        reconcileAndSync: vi.fn(async () => 1),
        syncNodeGrants: vi.fn(async () => undefined),
        getNodeGrantBundle: vi.fn(async () => grantBundle()),
        probeRelayCandidate,
      } as never,
      { publish: vi.fn() } as never,
      { log: vi.fn() } as never,
      { getConfig: vi.fn(async () => ({ relay: { assignmentSpread: { mode: 'fixed', count: 1 } } })) } as never
    );
    (service as any).probeRetryDelaysMs = [5, 5];
  }, 180_000);

  beforeEach(() => {
    clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // Relay liveness and revocation fences are covered elsewhere; these relays never report.
    vi.spyOn(service, 'fenceSilentRemoteInstances').mockResolvedValue(0);
    vi.spyOn(service, 'enforceRevocationDeadlines').mockResolvedValue(undefined);
    probe = async () => undefined;
    probeRelayCandidate.mockClear();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await database?.drop();
  });

  it('moves a dormant member whose source probes the lease gate refuses, and the pool is healthy', async () => {
    const endpointId = await memberEndpoint();
    // An nginx daemon older than rc.20 reports the lease gate's refusal of a standby member as a probe failure.
    probe = async (_node, { role }) => {
      if (role === 'source') throw new Error(GATE_CLOSED(dockerNode));
    };
    const [outcome] = await service.stageRebalance(undefined, { endpointIds: [endpointId] });
    expect(outcome).toMatchObject({ state: 'active', error: null });
    expect(probeRelayCandidate.mock.calls.filter(([, { role }]) => role === 'source')).toHaveLength(3);
    expect(await generations(endpointId)).toEqual([
      expect.objectContaining({ generation: 1, state: 'draining' }),
      expect.objectContaining({ generation: 2, state: 'active', relays: 3 }),
    ]);
    const snapshot = await service.getSnapshot();
    expect(snapshot.failures).toEqual([]);
    expect(snapshot.state).toBe('healthy');
  });

  it('defers a move while the daemon is busy or its node disconnected, and converges once that clears', async () => {
    const endpointId = await memberEndpoint();
    const failed = async () =>
      (await generations(endpointId)).filter(({ state }) => state === 'failed').map(({ generation }) => generation);

    probe = async () => {
      throw new Error(BUSY);
    };
    await automaticPass();
    let history = await generations(endpointId);
    expect(history.at(-1)).toMatchObject({ generation: 2, state: 'retired', activated_at: null });
    expect(history.at(-1)!.activation_error).toBe(
      `Deferred by a transient condition and retried automatically: ${BUSY}`
    );
    expect(await failed()).toEqual([]);
    let snapshot = await service.getSnapshot();
    expect(snapshot.failures).toEqual([]);
    expect(snapshot.state).toBe('rebalance_available');
    expect(snapshot.rebalanceEndpointIds).toContain(endpointId);

    probe = async (nodeId) => {
      throw new Error(`Node ${nodeId} is not connected`);
    };
    await automaticPass();
    history = await generations(endpointId);
    expect(history.at(-1)).toMatchObject({ generation: 3, state: 'retired', activated_at: null });
    expect(history.at(-1)!.activation_error).toContain(`Node ${dockerNode} is not connected`);
    expect(await failed()).toEqual([]);
    expect((await service.getSnapshot()).state).toBe('rebalance_available');

    // The condition clears: the next automatic attempt moves the member onto every lease relay.
    probe = async () => undefined;
    await automaticPass();
    history = await generations(endpointId);
    expect(history.at(-1)).toMatchObject({ generation: 4, state: 'active', relays: 3 });
    expect(await failed()).toEqual([]);
    snapshot = await service.getSnapshot();
    expect(snapshot.failures).toEqual([]);
    expect(snapshot.state).toBe('healthy');
  });

  it('keeps a genuine failure visible and degrading the pool until a verified attempt replaces it', async () => {
    const endpointId = await memberEndpoint();
    probe = async (_node, { role }) => {
      if (role === 'target') throw new Error('relay endpoint registration is not ready');
    };
    await automaticPass();
    expect((await generations(endpointId)).at(-1)).toMatchObject({ generation: 2, state: 'failed' });
    expect((await service.getSnapshot()).state).toBe('degraded');
    // A transient condition on the retry neither clears nor repeats the failure.
    probe = async () => {
      throw new Error(BUSY);
    };
    await automaticPass();
    expect((await generations(endpointId)).at(-1)).toMatchObject({ generation: 3, state: 'retired' });
    let snapshot = await service.getSnapshot();
    expect(snapshot.failures.map(({ generation }) => generation)).toEqual([2]);
    expect(snapshot.state).toBe('degraded');
    probe = async () => undefined;
    await automaticPass();
    expect((await generations(endpointId)).at(-1)).toMatchObject({ generation: 4, state: 'active' });
    snapshot = await service.getSnapshot();
    expect(snapshot.failures).toEqual([]);
    expect(snapshot.state).toBe('healthy');
  });

  it('rolls an interrupted preparation back instead of failing it, and verifies a fresh attempt', async () => {
    const endpointId = await memberEndpoint();
    // A Gateway restart left generation 2 staged three minutes ago, one probe acknowledged.
    const [staged] = (
      await q(
        `insert into relay_endpoint_assignment_generations (endpoint_id, generation, state, desired_redundancy,
           created_at, updated_at) values ($1, 2, 'staging', 3, now() - interval '3 minutes',
           now() - interval '3 minutes') returning id`,
        [endpointId]
      )
    ).rows;
    for (const relay of [localRelay, ...remoteRelays]) {
      await q(
        `insert into relay_endpoint_assignments (assignment_generation_id, relay_instance_id, role,
           target_registration_state) values ($1, $2, 'active', $3)`,
        [staged.id, relay, relay === localRelay ? 'ready' : 'pending']
      );
    }
    expect((await service.getSnapshot()).state).toBe('rebalancing');
    await service.reconcile();
    expect((await generations(endpointId)).at(-1)).toMatchObject({
      generation: 2,
      state: 'retired',
      activated_at: null,
      activation_error: expect.stringContaining('Rebalance preparation was interrupted'),
    });
    // Nothing was probed for the stale generation, and nothing failed.
    expect(probeRelayCandidate).not.toHaveBeenCalled();
    const snapshot = await service.getSnapshot();
    expect(snapshot.failures).toEqual([]);
    expect(snapshot.state).toBe('rebalance_available');

    await automaticPass();
    expect((await generations(endpointId)).at(-1)).toMatchObject({ generation: 3, state: 'active', relays: 3 });
    expect(probeRelayCandidate).toHaveBeenCalled();
    expect((await service.getSnapshot()).state).toBe('healthy');
  });

  it('leaves out a workload whose owner is revoked while its move is prepared, and moves the others', async () => {
    const kept = await memberEndpoint();
    const revoked = await memberEndpoint();
    probe = async (_node, { role, endpointId }) => {
      // The Secure Link lifecycle revokes the owner of a link it re-provisions, deleting its endpoint and, by
      // cascade, the generation being prepared.
      if (role === 'target' && endpointId === revoked) await q('delete from relay_endpoints where id = $1', [revoked]);
    };
    const outcomes = await service.stageRebalance(undefined, { endpointIds: [kept, revoked], automatic: true });
    expect(outcomes).toEqual([expect.objectContaining({ endpointId: kept, state: 'active' })]);
    expect(await generations(revoked)).toEqual([]);
    expect((await generations(kept)).at(-1)).toMatchObject({ generation: 2, state: 'active', relays: 3 });
    const snapshot = await service.getSnapshot();
    expect(snapshot.failures).toEqual([]);
    expect(snapshot.state).toBe('healthy');
  });
});
