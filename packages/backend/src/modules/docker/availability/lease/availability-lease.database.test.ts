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
  const ackAll = async (epoch: number, manifests: AvailabilityLeaseReport['manifests'] = []) => {
    for (const id of nodeIds)
      await service.ingestDaemonReport(id, 'docker', report(id, { epoch: String(epoch), manifests }));
    await service.ingestDaemonReport(nginxId, 'nginx', report(nginxId, { epoch: String(epoch), manifests }));
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

  it('publishes a signed voter config and waits for a voter majority to persist it', async () => {
    await ackAll(0);
    await service.reconcile();
    const [cluster] = (await q('select epoch, quorum_sets, voter_config_block from availability_lease_cluster')).rows;
    expect(Number(cluster.epoch)).toBe(1);
    // One vote per host: the local relay and four daemons make five, an odd total.
    expect(cluster.quorum_sets).toHaveLength(1);
    expect(cluster.quorum_sets[0]).toHaveLength(5);
    const block = decodeLeaseSignedBlock(Buffer.from(cluster.voter_config_block, 'base64'));
    expect(verify(null, leaseBlockMessage(block.kind, block.payload), policyKey.publicKeyObject, block.signature)).toBe(
      true
    );
    expect((await service.getPolicyLease(policyId)).reason).toMatchObject({ code: 'voter_config_pending' });
    // Legacy: the relay keeps legacy admission for every endpoint and route.
    expect(await gateIds()).toEqual({ endpoints: {}, routes: {} });
  });

  it('bootstraps the policy with its serving placement as reserved holder (A5)', async () => {
    await ackAll(1);
    await service.reconcile();
    const view = await service.getPolicyLease(policyId);
    expect(view.mode).toBe('bootstrapping');
    expect(view.bootstrap).toEqual([{ slot: 0, holderNodeId: nodeIds[0] }]);
    expect(modeChanges.at(-1)).toMatchObject({ policyId, from: 'legacy', to: 'bootstrapping' });
    const [state] = (await q('select manifest_block from docker_availability_lease_state')).rows;
    const manifest = decodeRelayV1Message(
      'LeaseManifest',
      decodeLeaseSignedBlock(Buffer.from(state.manifest_block, 'base64')).payload
    ) as { candidates: Array<{ id: string }>; bootstrap: unknown[]; closed: boolean };
    expect(manifest.candidates.map((candidate) => candidate.id)).toEqual(nodeIds);
    expect(manifest.bootstrap).toEqual([{ slot: 0, holderId: nodeIds[0] }]);
    const sync = sent.filter(({ command }) => command.syncAvailabilityLease).at(-1)?.command.syncAvailabilityLease;
    expect(sync?.manifests).toHaveLength(1);
    expect(sync?.policyKeys.map((key) => key.keyId)).toEqual([keyId]);
    const relayFields = await service.relayPolicyFields();
    expect(relayFields.leaseBlocks.map((block) => block.kind)).toEqual([
      'LEASE_BLOCK_KIND_VOTER_CONFIG',
      'LEASE_BLOCK_KIND_MANIFEST',
    ]);
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
    expect(view.voterMargin).toMatchObject({ epoch: 1, voters: 5, reachable: 5, required: 3, margin: 2 });
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
    const [before] = (await q('select voter_config_block from availability_lease_cluster')).rows;
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
    const [after] = (await q('select signing_key_id, voter_config_block from availability_lease_cluster')).rows;
    expect(after.signing_key_id).toBe(nextKeyId);
    const oldConfig = decodeLeaseSignedBlock(Buffer.from(before.voter_config_block, 'base64'));
    const newConfig = decodeLeaseSignedBlock(Buffer.from(after.voter_config_block, 'base64'));
    expect(newConfig.signingKeyId).toBe(nextKeyId);
    expect(newConfig.payload).toEqual(oldConfig.payload);
    const [stateAfter] = (await q('select manifest_block, manifest_version from docker_availability_lease_state')).rows;
    expect(stateAfter.manifest_version).toBe(stateBefore.manifest_version);
    const manifest = decodeLeaseSignedBlock(Buffer.from(stateAfter.manifest_block, 'base64'));
    expect(manifest.signingKeyId).toBe(nextKeyId);
    expect(manifest.payload).toEqual(decodeLeaseSignedBlock(Buffer.from(stateBefore.manifest_block, 'base64')).payload);
    expect(
      verify(null, leaseBlockMessage(manifest.kind, manifest.payload), nextKey.publicKeyObject, manifest.signature)
    ).toBe(true);
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
    expect((await service.relayPolicyFields()).leaseBlocks).toHaveLength(1);
  });
});
