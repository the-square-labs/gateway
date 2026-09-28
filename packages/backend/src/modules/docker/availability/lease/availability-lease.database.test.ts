import { createHash, generateKeyPairSync, type KeyObject, randomUUID, sign, verify } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import type { AvailabilityLeaseReport, GatewayCommand } from '@/grpc/generated/types.js';
import { decodeRelayV1Message } from '@/grpc/relay-proto.js';
import { AvailabilityLeaseService } from './availability-lease.service.js';
import { decodeLeaseSignedBlock, leaseBlockMessage } from './lease-codec.js';
import type { DockerAvailabilityLeaseHolderChange, DockerAvailabilityLeaseModeChange } from './lease-types.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;

function edKey(): { privateKey: KeyObject; publicKeyObject: KeyObject; publicKey: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const { x } = publicKey.export({ format: 'jwk' }) as { x: string };
  return { privateKey, publicKeyObject: publicKey, publicKey: Buffer.from(x, 'base64url') };
}

function identityKey(): Buffer {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
}

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL, see migration-database.test-helpers): the lease host end to end on
 * PostgreSQL. Voters and epoch, capability gating, bootstrap, signed manifests, holder reports with audit, and the
 * lease-closed handover back to legacy.
 */
describe.skipIf(!url)('availability lease host on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let service: AvailabilityLeaseService;
  const policyKey = edKey();
  const keyId = randomUUID();
  const nextKey = edKey();
  const nextKeyId = randomUUID();
  const signers = new Map<string, ReturnType<typeof edKey>>([
    [keyId, policyKey],
    [nextKeyId, nextKey],
  ]);
  const relayId = randomUUID();
  const nodeIds = [randomUUID(), randomUUID(), randomUUID()];
  const nginxId = randomUUID();
  const policyId = randomUUID();
  const identities = new Map<string, Buffer>();
  const sent: Array<{ nodeId: string; command: Partial<GatewayCommand> }> = [];
  const audit = { log: vi.fn(async () => true) };
  const events = { publish: vi.fn() };
  const modeChanges: DockerAvailabilityLeaseModeChange[] = [];
  const holderChanges: DockerAvailabilityLeaseHolderChange[] = [];
  const connected = [...nodeIds.map((id) => ({ id, type: 'docker' })), { id: nginxId, type: 'nginx' }].map(
    ({ id, type }) => ({ nodeId: id, connectionId: `c-${id}`, type, capabilities: new Set(['availability_lease_v1']) })
  );
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const memberLinkId = randomUUID();
  const projectionId = randomUUID();
  const gateOwners = {
    endpoints: [
      { id: 'endpoint-member', ownerKind: 'proxy_host_secure_link', ownerId: memberLinkId },
      { id: 'endpoint-other', ownerKind: 'proxy_host_secure_link', ownerId: randomUUID() },
    ],
    routes: [{ id: 'route-projection', ownerKind: 'managed_database_binding', ownerId: projectionId }],
  };
  const gateIds = async () => {
    const ids = await service.relayLeasePolicyIds(gateOwners.endpoints, gateOwners.routes);
    return { endpoints: Object.fromEntries(ids.endpoints), routes: Object.fromEntries(ids.routes) };
  };

  const report = (memberId: string, extra: Partial<AvailabilityLeaseReport> = {}): AvailabilityLeaseReport => ({
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
    ...extra,
  });
  // What the nginx daemon sends (buildReport in the nginx daemon): an observer with no member id, identity or votes.
  const nginxReport = (): AvailabilityLeaseReport => ({
    memberId: '',
    identityPublicKey: Buffer.alloc(0),
    incarnation: '0',
    epoch: '0',
    trustedPolicyKeyIds: [],
    manifests: [],
    held: [],
    acceptor: [],
    acceptorAbstaining: false,
    watchdogReady: false,
    events: [],
    leaseRevision: '1',
  });
  const ackAll = async (epoch: number, manifests: AvailabilityLeaseReport['manifests'] = []) => {
    for (const id of nodeIds)
      await service.ingestDaemonReport(id, 'docker', report(id, { epoch: String(epoch), manifests }));
    await service.ingestDaemonReport(nginxId, 'nginx', nginxReport());
    await service.ingestRelayReport(relayId, report(relayId, { epoch: String(epoch), manifests }));
  };
  const holding = (nodeId: string, round: number) =>
    report(nodeId, {
      epoch: '1',
      held: [
        {
          policyId,
          slot: 0,
          role: 'holding',
          ballot: { round: String(round), incarnation: '1', proposerId: nodeId },
          epoch: '1',
          manifestVersion: '1',
          placementId: '',
          placementGeneration: '1',
        },
      ],
    });

  beforeAll(async () => {
    // Data-plane failover is a preview that the operator turns on (GATEWAY_AVAILABILITY_LEASE_MODE).
    process.env.GATEWAY_AVAILABILITY_LEASE_MODE = 'enabled';
    database = await disposableDatabase(url!, 'lease');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    await q(
      `insert into relay_policy_signing_keys (key_id, public_key, public_key_fingerprint, encrypted_private_key,
         encrypted_dek, status, activated_at) values ($1, $2, $3, 'held', 'held', 'active', now())`,
      [
        keyId,
        policyKey.publicKey.toString('base64'),
        `sha256:${createHash('sha256').update(policyKey.publicKey).digest('hex')}`,
      ]
    );
    await q(`insert into relay_pools (id) values ('system') on conflict do nothing`);
    await q(
      `insert into relay_instances (id, pool_id, kind, fault_domain_id, display_name, state, capabilities)
       values ($1, 'system', 'local', gen_random_uuid(), 'local', 'ready', $2)`,
      [relayId, JSON.stringify({ protocolMajor: 1, features: ['relay_pool_v1', 'availability_lease_v1'] })]
    );
    for (const [index, id] of [...nodeIds, nginxId].entries()) {
      await q(
        `insert into nodes (id, type, hostname, slug, status, host_identity_id, capabilities)
         values ($1, $2, $3, $3, 'online', gen_random_uuid(), $4)`,
        [
          id,
          id === nginxId ? 'nginx' : 'docker',
          `node-${index}`,
          JSON.stringify({ capabilities: ['availability_lease_v1'] }),
        ]
      );
    }
    for (const id of [relayId, ...nodeIds, nginxId]) identities.set(id, identityKey());
    await q(
      `insert into docker_availability_policies (id, resource_kind, source_node_id, container_name, mode,
         desired_replica_count, status) values ($1, 'container', $2, 'app', 'failover', 1, 'healthy')`,
      [policyId, nodeIds[0]]
    );
    for (const [index, id] of nodeIds.entries()) {
      await q(
        `insert into docker_availability_placements (policy_id, node_id, generation, desired_state, actual_state,
           serving, spec_fingerprint, created_at) values ($1, $2, 1, $3, $4, $5, 'spec', now() + ($6 || ' seconds')::interval)`,
        [
          policyId,
          id,
          index === 0 ? 'serving' : 'standby',
          index === 0 ? 'serving' : 'ready',
          index === 0,
          String(index),
        ]
      );
    }
    const [placement] = (
      await q('select id from docker_availability_placements where policy_id = $1 and node_id = $2', [
        policyId,
        nodeIds[0],
      ])
    ).rows;
    const group = randomUUID();
    const user = randomUUID();
    await q('insert into permission_groups (id, name) values ($1, $2)', [group, `lease-${group}`]);
    await q('insert into users (id, group_id, email, name) values ($1, $2, $3, $4)', [
      user,
      group,
      `${user}@lease.test`,
      'Lease test',
    ]);
    const hostId = randomUUID();
    await q(`insert into proxy_hosts (id, slug, created_by_id) values ($1, 'lease-host', $2)`, [hostId, user]);
    await q(
      `insert into proxy_additional_secure_links (id, proxy_host_id, name, purpose, reference_id,
         availability_owner_key, upstream_kind, source_node_id, docker_node_id, docker_container_port,
         docker_host_port, target_container, status)
       values ($1, $2, 'member', 'availability_member', $3, $4, 'docker_container', $5, $6, 80, 8080, 'app', 'active')`,
      [memberLinkId, hostId, placement.id, `proxy-host:${hostId}`, nginxId, nodeIds[0]]
    );
    const databaseId = randomUUID();
    await q(
      `insert into managed_database_instances (id, node_id, name, slug, type, version, image_ref, engine_config,
         encrypted_owner_credentials, storage_size_bytes, published_port, created_by_id)
       values ($1, $2, 'db', 'db', 'postgres', '17', 'img', '{}', 'x', 1, null, $3)`,
      [databaseId, nodeIds[2], user]
    );
    const bindingId = randomUUID();
    await q(
      `insert into managed_database_bindings (id, managed_database_id, target_node_id, target_type, target_resource_id,
         network_name, connector_name, connector_alias, environment, encrypted_credentials, created_by_id)
       values ($1, $2, $3, 'container', 'app', 'n', 'c', 'a', '{}', 'x', $4)`,
      [bindingId, databaseId, nodeIds[0], user]
    );
    await q(
      `insert into managed_database_binding_placements (id, binding_id, availability_placement_id, node_id,
         network_name, connector_name, connector_alias) values ($1, $2, $3, $4, 'n', 'c', 'a')`,
      [projectionId, bindingId, placement.id, nodeIds[0]]
    );
    const registry = {
      getNode: (id: string) => connected.find((node) => node.nodeId === id),
      getAllNodes: () => connected,
      hasCapability: (id: string, capability: string) =>
        connected.find((node) => node.nodeId === id)?.capabilities.has(capability) ?? false,
      sendCommand: vi.fn(async (nodeId: string, command: Partial<GatewayCommand>) => {
        sent.push({ nodeId, command });
        return { commandId: 'c', success: true, error: '', detail: '', data: Buffer.alloc(0) };
      }),
    };
    service = new AvailabilityLeaseService(db, registry as never, audit, events as never, {
      signPayload: async (payload: Buffer, signer?: string) => {
        const key = signers.get(signer ?? '');
        if (!key) throw new Error(`unexpected signer ${signer}`);
        return { signingKeyId: signer!, signature: sign(null, payload, key.privateKey) };
      },
    });
    service.attachController({
      leaseModeSupported: () => true,
      leaseModeChanged: async (change) => {
        modeChanges.push(change);
      },
      leaseHolderChanged: async (change) => {
        holderChanges.push(change);
      },
    });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('keeps legacy admission while the candidates have not reported lease identities', async () => {
    await service.reconcile();
    expect((await service.getPolicyLease(policyId)).reason).toMatchObject({ code: 'candidates_not_capable' });
    expect(await gateIds()).toEqual({ endpoints: {}, routes: {} });
  });

  it('bootstraps with per-policy voters and every relay as a non-voting member (A5, A18)', async () => {
    await ackAll(0);
    await service.reconcile();
    const view = await service.getPolicyLease(policyId);
    expect(view.mode).toBe('bootstrapping');
    expect(view.bootstrap).toEqual([{ slot: 0, holderNodeId: nodeIds[0] }]);
    // Three candidates on three hosts are an odd voter set: no witness needed.
    expect(view.voters).toEqual([...nodeIds].sort());
    expect(view.witness).toEqual({ memberId: null, kind: null, auto: true, minRttMs: null, warning: null });
    expect(modeChanges.at(-1)).toMatchObject({ policyId, from: 'legacy', to: 'bootstrapping' });
    const [state] = (await q('select manifest_block from docker_availability_lease_state')).rows;
    const block = decodeLeaseSignedBlock(Buffer.from(state.manifest_block, 'base64'));
    expect(verify(null, leaseBlockMessage(block.kind, block.payload), policyKey.publicKeyObject, block.signature)).toBe(
      true
    );
    const manifest = decodeRelayV1Message('LeaseManifest', block.payload) as {
      candidates: Array<{ id: string }>;
      bootstrap: unknown[];
      voterEpoch: string;
      members: Array<{ id: string; role: string }>;
      quorumSets: Array<{ voterIds: string[] }>;
    };
    expect(manifest.candidates.map((candidate) => candidate.id)).toEqual(nodeIds);
    expect(manifest.bootstrap).toEqual([{ slot: 0, holderId: nodeIds[0] }]);
    expect(manifest.voterEpoch).toBe('1');
    expect(manifest.quorumSets).toEqual([{ voterIds: [...nodeIds].sort() }]);
    // The relay keeps shadow accepts as a non-voting member; the nginx daemon is an observer, never a member.
    expect(manifest.members.find((member) => member.id === relayId)).toMatchObject({ role: 'LEASE_MEMBER_ROLE_RELAY' });
    expect(manifest.members.map((member) => member.id)).not.toContain(nginxId);
    const sync = sent.filter(({ command }) => command.syncAvailabilityLease).at(-1)?.command.syncAvailabilityLease;
    expect(sync?.manifests).toHaveLength(1);
    expect(sync?.voterConfig).toHaveLength(0);
    expect(sync?.policyKeys.map((key) => key.keyId)).toEqual([keyId]);
    const relayFields = await service.relayPolicyFields();
    expect(relayFields.leaseBlocks.map((entry) => entry.kind)).toEqual(['LEASE_BLOCK_KIND_MANIFEST']);
    // Bootstrapping keeps legacy admission until the reserved holder committed (A5).
    expect(await gateIds()).toEqual({ endpoints: {}, routes: {} });
  });

  it('enters lease mode once the reserved holder acquired and the gate window passed, then audits a failover', async () => {
    await service.ingestDaemonReport(nodeIds[0]!, 'docker', holding(nodeIds[0]!, 3));
    await service.reconcile();
    const settling = await service.getPolicyLease(policyId);
    expect(settling.mode).toBe('bootstrapping');
    expect(settling.copiesStoppedAt).toBeInstanceOf(Date);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 25_000 });
    try {
      await service.reconcile();
    } finally {
      vi.useRealTimers();
    }
    expect((await service.getPolicyLease(policyId)).mode).toBe('lease');
    expect(audit.log).not.toHaveBeenCalled();
    expect(await gateIds()).toEqual({
      endpoints: { 'endpoint-member': policyId },
      routes: { 'route-projection': policyId },
    });

    await service.ingestDaemonReport(nodeIds[0]!, 'docker', report(nodeIds[0]!, { epoch: '1' }));
    await service.ingestDaemonReport(nodeIds[1]!, 'docker', holding(nodeIds[1]!, 7));
    const view = await service.getPolicyLease(policyId);
    expect(view.holders[0]).toMatchObject({ slot: 0, holderNodeId: nodeIds[1], source: 'daemon' });
    expect(view.voterMargin).toMatchObject({ epoch: 1, voters: 3, reachable: 3, required: 2, margin: 1 });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'docker.availability.lease_failover',
        resourceId: policyId,
        details: expect.objectContaining({ fromNodeId: nodeIds[0], toNodeId: nodeIds[1] }),
      })
    );
    expect(holderChanges.at(-1)).toMatchObject({ kind: 'failover', to: nodeIds[1] });
  });

  it('audits a planned move as a handoff (D9)', async () => {
    await service.registerPlannedHandoff(policyId, { slot: 0, fromHolderId: nodeIds[1]!, toHolderId: nodeIds[2]! });
    await service.ingestDaemonReport(nodeIds[2]!, 'docker', holding(nodeIds[2]!, 9));
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'docker.availability.lease_handoff' })
    );
  });

  it('signs with a rotated policy key once a voter majority trusts it, re-signing the same payloads (A14, A16)', async () => {
    const [stateBefore] = (await q('select manifest_block, manifest_version from docker_availability_lease_state'))
      .rows;
    await q(`update relay_policy_signing_keys set status = 'verification_only' where key_id = $1`, [keyId]);
    await q(
      `insert into relay_policy_signing_keys (key_id, public_key, public_key_fingerprint, encrypted_private_key,
         encrypted_dek, status, activated_at, created_at) values ($1, $2, 'sha256:next', 'held', 'held', 'active', now(),
         now() + interval '1 second')`,
      [nextKeyId, nextKey.publicKey.toString('base64')]
    );
    await service.reconcile();
    const [link] = (await q('select previous_key_id, signature from availability_lease_key_rotations')).rows;
    expect(link.previous_key_id).toBe(keyId);
    expect((await q('select signing_key_id from availability_lease_cluster')).rows[0].signing_key_id).toBe(keyId);

    for (const id of [...nodeIds, nginxId]) {
      await service.ingestDaemonReport(
        id,
        id === nginxId ? 'nginx' : 'docker',
        report(id, { epoch: '1', trustedPolicyKeyIds: [keyId, nextKeyId] })
      );
    }
    await service.reconcile();
    const [after] = (await q('select signing_key_id from availability_lease_cluster')).rows;
    expect(after.signing_key_id).toBe(nextKeyId);
    const [stateAfter] = (await q('select manifest_block, manifest_version from docker_availability_lease_state')).rows;
    expect(stateAfter.manifest_version).toBe(stateBefore.manifest_version);
    const manifest = decodeLeaseSignedBlock(Buffer.from(stateAfter.manifest_block, 'base64'));
    expect(manifest.signingKeyId).toBe(nextKeyId);
    expect(manifest.payload).toEqual(decodeLeaseSignedBlock(Buffer.from(stateBefore.manifest_block, 'base64')).payload);
    expect(
      verify(null, leaseBlockMessage(manifest.kind, manifest.payload), nextKey.publicKeyObject, manifest.signature)
    ).toBe(true);
  });

  it('moves the voters through a per-policy joint epoch when a candidate leaves, adding a witness (A4, A18, A19)', async () => {
    const epochOf = async () => (await service.getPolicyLease(policyId)).epoch;
    const before = await epochOf();
    await q(
      `update docker_availability_placements set desired_state = 'removed' where policy_id = $1 and node_id = $2`,
      [policyId, nodeIds[2]]
    );
    await service.reconcile();
    const joint = await service.getPolicyLease(policyId);
    expect(joint.epoch).toBe(before + 1);
    expect(joint.voterMargin?.joint).toBe(true);
    // Two candidates need a witness: the relay (no RTT data here, so the fault-domain fallback picks it).
    expect(joint.voters).toEqual([nodeIds[0], nodeIds[1], relayId].sort());
    expect(joint.witness).toMatchObject({ memberId: relayId, kind: 'relay', auto: true, warning: null });
    const jointEpoch = String(joint.epoch);
    const manifests = [
      { policyId, manifestVersion: String(joint.manifestVersion), closed: false, voterEpoch: jointEpoch, voter: true },
    ];
    for (const id of [nodeIds[0]!, nodeIds[1]!])
      await service.ingestDaemonReport(id, 'docker', report(id, { manifests }));
    await service.ingestRelayReport(relayId, report(relayId, { manifests }));
    await service.reconcile();
    expect(await epochOf()).toBe(before + 1);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    try {
      await service.reconcile();
    } finally {
      vi.useRealTimers();
    }
    const settled = await service.getPolicyLease(policyId);
    expect(settled.epoch).toBe(before + 2);
    expect(settled.voterMargin?.joint).toBe(false);
    expect(settled.voters).toEqual([nodeIds[0], nodeIds[1], relayId].sort());
    await q(
      `update docker_availability_placements set desired_state = 'standby' where policy_id = $1 and node_id = $2`,
      [policyId, nodeIds[2]]
    );
  });

  it('validates a configured witness (A19)', async () => {
    await expect(service.validateWitness(relayId, { policyId })).resolves.toBeUndefined();
    await expect(service.validateWitness(nodeIds[0]!, { policyId })).rejects.toMatchObject({
      code: 'AVAILABILITY_WITNESS_IS_CANDIDATE',
    });
    await expect(service.validateWitness(nginxId, { policyId })).rejects.toMatchObject({
      code: 'AVAILABILITY_WITNESS_INVALID',
    });
    await expect(service.validateWitness(randomUUID(), { policyId })).rejects.toMatchObject({
      code: 'AVAILABILITY_WITNESS_NOT_FOUND',
    });
    await expect(service.setWitness(policyId, 'not-a-uuid')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('closes lease mode when a candidate loses the capability and hands back to legacy (A5)', async () => {
    await service.ingestDaemonReport(nodeIds[1]!, 'docker', report(nodeIds[1]!, { epoch: '1', watchdogReady: false }));
    await service.reconcile();
    const closing = await service.getPolicyLease(policyId);
    expect(closing.mode).toBe('closing');
    expect(await gateIds()).toEqual({ endpoints: {}, routes: {} });
    expect(closing.reason).toMatchObject({ code: 'candidates_not_capable', nodeIds: [nodeIds[1]] });
    expect(await service.isReactive(policyId)).toBe(false);
    await service.ingestDaemonReport(
      nodeIds[2]!,
      'docker',
      report(nodeIds[2]!, {
        epoch: '1',
        manifests: [{ policyId, manifestVersion: String(closing.manifestVersion), closed: true }],
      })
    );
    await service.reconcile();
    expect((await service.getPolicyLease(policyId)).mode).toBe('legacy');
    expect(await service.isReactive(policyId)).toBe(true);
    expect(modeChanges.at(-1)).toMatchObject({ to: 'legacy', lastHolders: [{ slot: 0, holderId: nodeIds[2] }] });
    expect((await service.relayPolicyFields()).leaseBlocks).toHaveLength(0);
  });

  it('publishes temporary surge slots for a replicated rollout and rejects surge in failover (D9)', async () => {
    await expect(service.setSurgeSlots(policyId, 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'AVAILABILITY_LEASE_SURGE_UNSUPPORTED',
    });
    await q(
      `update docker_availability_policies set mode = 'replicated', desired_replica_count = 2,
         rollout_policy = '{"maxUnavailable":0,"maxSurge":1,"drainSeconds":30}' where id = $1`,
      [policyId]
    );
    const manifestSlots = async () => {
      const [state] = (await q('select manifest_block, manifest_version from docker_availability_lease_state')).rows;
      const manifest = decodeRelayV1Message(
        'LeaseManifest',
        decodeLeaseSignedBlock(Buffer.from(state.manifest_block, 'base64')).payload
      ) as { slots: number; manifestVersion: string };
      return { slots: manifest.slots, version: Number(state.manifest_version) };
    };
    let now = Date.now();
    try {
      // Re-enter lease mode: every member is capable again; let the voter epochs settle.
      for (let round = 0; round < 10 && (await service.getPolicyLease(policyId)).mode === 'legacy'; round++) {
        now += 61_000;
        vi.useFakeTimers({ toFake: ['Date'], now });
        await ackAll(0);
        await service.reconcile();
      }
      expect((await service.getPolicyLease(policyId)).mode).toBe('bootstrapping');
      const base = await manifestSlots();
      expect(base.slots).toBe(2);

      await service.setSurgeSlots(policyId, 1);
      const raised = await manifestSlots();
      expect(raised).toEqual({ slots: 3, version: base.version + 1 });
      expect((await service.getPolicyLease(policyId)).surgeSlots).toBe(1);

      await expect(service.setSurgeSlots(policyId, 2)).rejects.toMatchObject({ statusCode: 400 });
      await service.setSurgeSlots(policyId, 0);
      expect(await manifestSlots()).toEqual({ slots: 2, version: base.version + 2 });
      expect((await service.getPolicyLease(policyId)).surgeSlots).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
