import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import type { AvailabilityLeaseReport } from '@/grpc/generated/types.js';
import { decodeRelayV1Message } from '@/grpc/relay-proto.js';
import { AvailabilityLeaseService } from './availability-lease.service.js';
import { decodeLeaseSignedBlock } from './lease-codec.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;

// Each test runs several reconciles against PostgreSQL; a loaded runner must not turn that into a timeout.
vi.setConfig({ testTimeout: 60_000 });

function identityKey(): Buffer {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
}

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): identity renewals republish manifests at once (H3), and a relay
 * without the lease gate that carries the policy's traffic moves the policy back to the legacy path (H4) once that
 * lasted 2 minutes (D3).
 */
describe.skipIf(!url)('availability lease identity renewal and relay gating on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let service: AvailabilityLeaseService;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  const keyId = randomUUID();
  const relayId = randomUUID();
  const oldRelayId = randomUUID();
  const nodeIds = [randomUUID(), randomUUID()];
  const policyId = randomUUID();
  const identities = new Map<string, Buffer>();
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const report = (memberId: string): AvailabilityLeaseReport => ({
    memberId,
    identityPublicKey: identities.get(memberId)!,
    incarnation: '1',
    epoch: '0',
    trustedPolicyKeyIds: [keyId],
    manifests: [],
    held: [],
    acceptor: [],
    acceptorAbstaining: false,
    watchdogReady: true,
    events: [],
    leaseRevision: '0',
  });
  const manifest = async () => {
    const [state] = (await q('select manifest_block, manifest_version from docker_availability_lease_state')).rows;
    const payload = decodeLeaseSignedBlock(Buffer.from(state.manifest_block, 'base64')).payload;
    const value = decodeRelayV1Message('LeaseManifest', payload) as {
      candidates: Array<{ id: string; publicKey: Buffer }>;
      members: Array<{ id: string; publicKey: Buffer }>;
    };
    return { ...value, version: Number(state.manifest_version) };
  };

  // Migrating a fresh database can take far longer than the default 10 s hook timeout on a loaded runner, and a
  // timed-out hook let the tests run against a half-prepared database (the gates suite failed that way under load).
  beforeAll(async () => {
    database = await disposableDatabase(url!, 'lease_gates');
    pool = database.pool;
    await migrateDatabase(pool);
    const db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    await q(
      `insert into relay_policy_signing_keys (key_id, public_key, public_key_fingerprint, encrypted_private_key,
         encrypted_dek, status, activated_at) values ($1, $2, $3, 'held', 'held', 'active', now())`,
      [keyId, rawPublicKey.toString('base64'), `sha256:${createHash('sha256').update(rawPublicKey).digest('hex')}`]
    );
    await q(`insert into relay_pools (id) values ('system') on conflict do nothing`);
    for (const [id, features] of [
      [relayId, ['relay_pool_v1', 'availability_lease_v2']],
      [oldRelayId, ['relay_pool_v1']],
    ] as const) {
      await q(
        `insert into relay_instances (id, pool_id, kind, fault_domain_id, display_name, state, capabilities)
         values ($1, 'system', $2, gen_random_uuid(), $4, 'ready', $3)`,
        [id, id === relayId ? 'local' : 'remote', JSON.stringify({ protocolMajor: 1, features }), `relay-${id}`]
      );
    }
    for (const [index, id] of nodeIds.entries()) {
      await q(
        `insert into nodes (id, type, hostname, slug, status, host_identity_id, capabilities)
         values ($1, 'docker', $2, $2, 'online', gen_random_uuid(), $3)`,
        [id, `gate-node-${index}`, JSON.stringify({ capabilities: ['availability_lease_v2'] })]
      );
    }
    for (const id of [relayId, ...nodeIds]) identities.set(id, identityKey());
    await q(
      `insert into docker_availability_policies (id, resource_kind, source_node_id, container_name, mode,
         desired_replica_count, status) values ($1, 'container', $2, 'app', 'failover', 1, 'healthy')`,
      [policyId, nodeIds[0]]
    );
    for (const [index, id] of nodeIds.entries()) {
      await q(
        `insert into docker_availability_placements (policy_id, node_id, generation, desired_state, actual_state,
           serving, spec_fingerprint) values ($1, $2, 1, $3, $4, $5, 'spec')`,
        [policyId, id, index === 0 ? 'serving' : 'standby', index === 0 ? 'serving' : 'ready', index === 0]
      );
    }
    const connected = nodeIds.map((id) => ({
      nodeId: id,
      connectionId: `c-${id}`,
      type: 'docker',
      capabilities: new Set(['availability_lease_v2']),
    }));
    service = new AvailabilityLeaseService(
      db,
      {
        getNode: (id: string) => connected.find((node) => node.nodeId === id),
        getAllNodes: () => connected,
        hasCapability: () => true,
        sendCommand: vi.fn(async () => ({
          commandId: 'c',
          success: true,
          error: '',
          detail: '',
          data: Buffer.alloc(0),
        })),
      } as never,
      { log: vi.fn(async () => true) },
      { publish: vi.fn() } as never,
      {
        signPayload: async (payload: Buffer) => ({ signingKeyId: keyId, signature: sign(null, payload, privateKey) }),
      }
    );
    service.attachController({
      leaseModeSupported: () => true,
      leaseModeChanged: async () => undefined,
      leaseHolderChanged: async () => undefined,
    });
    for (const id of nodeIds) await service.ingestDaemonReport(id, 'docker', report(id));
    await service.ingestRelayReport(relayId, report(relayId));
    await service.reconcile();
    // Lease mode starts once every participant was ready for 2 minutes without a restart.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 121_000 });
    try {
      await service.reconcile();
    } finally {
      vi.useRealTimers();
    }
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  }, 60_000);

  it('republishes every manifest with a renewed identity key right away (H3)', async () => {
    const before = await manifest();
    const oldKey = identities.get(nodeIds[0]!)!;
    expect(before.candidates.find(({ id }) => id === nodeIds[0])?.publicKey).toEqual(oldKey);
    identities.set(nodeIds[0]!, identityKey());
    await service.ingestDaemonReport(nodeIds[0]!, 'docker', report(nodeIds[0]!));
    await service.reconcile();
    const after = await manifest();
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.candidates.find(({ id }) => id === nodeIds[0])?.publicKey).toEqual(identities.get(nodeIds[0]!));
    expect(after.members.find(({ id }) => id === nodeIds[0])?.publicKey).toEqual(identities.get(nodeIds[0]!));
    const [member] = (
      await q(
        'select previous_identity_public_key, identity_rotated_at from availability_lease_members where member_id = $1',
        [nodeIds[0]]
      )
    ).rows;
    expect(Buffer.from(member.previous_identity_public_key, 'base64')).toEqual(oldKey);
    expect(member.identity_rotated_at).toBeInstanceOf(Date);
  });

  it('stays on the legacy path while a relay without the lease gate carries the policy (H4)', async () => {
    expect((await service.getPolicyLease(policyId)).mode).toBe('bootstrapping');
    const group = randomUUID();
    const user = randomUUID();
    await q('insert into permission_groups (id, name) values ($1, $2)', [group, `gates-${group}`]);
    await q("insert into users (id, group_id, email, name) values ($1, $2, $3, 'Gates')", [
      user,
      group,
      `${user}@g.test`,
    ]);
    const hostId = randomUUID();
    await q(`insert into proxy_hosts (id, slug, created_by_id) values ($1, 'gates-host', $2)`, [hostId, user]);
    const [placement] = (
      await q('select id from docker_availability_placements where policy_id = $1 and node_id = $2', [
        policyId,
        nodeIds[0],
      ])
    ).rows;
    const linkId = randomUUID();
    await q(
      `insert into proxy_additional_secure_links (id, proxy_host_id, name, purpose, reference_id,
         availability_owner_key, upstream_kind, source_node_id, docker_node_id, docker_container_port,
         docker_host_port, target_container, status)
       values ($1, $2, 'member', 'availability_member', $3, $4, 'docker_container', $5, $5, 80, 8080, 'app', 'active')`,
      [linkId, hostId, placement.id, `proxy-host:${hostId}`, nodeIds[0]]
    );
    const [endpoint] = (
      await q(
        `insert into relay_endpoints (owner_kind, owner_id, subject_kind, subject_id, certificate_sha256)
         values ('proxy_host_secure_link', $1, 'daemon', $2, 'sha256:x') returning id`,
        [linkId, nodeIds[0]]
      )
    ).rows;
    const [generation] = (
      await q(
        `insert into relay_endpoint_assignment_generations (endpoint_id, generation, state)
         values ($1, 1, 'active') returning id`,
        [endpoint.id]
      )
    ).rows;
    for (const relay of [relayId, oldRelayId]) {
      await q(
        `insert into relay_endpoint_assignments (assignment_generation_id, relay_instance_id, role)
         values ($1, $2, 'active')`,
        [generation.id, relay]
      );
    }
    await service.reconcile();
    // D3: lease mode ends only after it stayed impossible for 2 minutes; until then the reason says since when.
    const pending = await service.getPolicyLease(policyId);
    expect(pending.mode).toBe('bootstrapping');
    expect(pending.reason).toMatchObject({
      code: 'relays_not_capable',
      relayIds: [oldRelayId],
      since: expect.any(String),
    });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 121_000 });
    try {
      await service.reconcile();
    } finally {
      vi.useRealTimers();
    }
    const view = await service.getPolicyLease(policyId);
    expect(view.mode).toBe('closing');
    expect(view.reason).toMatchObject({ code: 'relays_not_capable', relayIds: [oldRelayId] });
  });
});
