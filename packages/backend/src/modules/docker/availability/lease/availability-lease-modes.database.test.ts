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
import type { DockerAvailabilityLeaseModeChange } from './lease-types.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;

// Each test runs several reconciles against PostgreSQL; a loaded runner must not turn that into a timeout.
vi.setConfig({ testTimeout: 60_000 });

function identityKey(): Buffer {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
}

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): lease mode transitions of the rc.20 fixes on PostgreSQL (D3).
 * Per-node conditions exclude a node instead of flipping the mode, outdated members leave voters and manifests only
 * after a 2-minute grace, the automatic witness moves off Gateway's local relay by itself (N-2), a fenced holder that
 * stops running leaves the claimants, and a closing lease hands over to legacy only once every lease expired.
 */
describe.skipIf(!url)('availability lease modes on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let service: AvailabilityLeaseService;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  const keyId = randomUUID();
  const localRelay = randomUUID();
  const remoteRelay = randomUUID();
  const nodeIds = [randomUUID(), randomUUID(), randomUUID()];
  const pairPolicy = randomUUID();
  const triplePolicy = randomUUID();
  const identities = new Map<string, Buffer>();
  const modeChanges: DockerAvailabilityLeaseModeChange[] = [];
  const connected = nodeIds.map((id) => ({
    nodeId: id,
    connectionId: `c-${id}`,
    type: 'docker',
    capabilities: new Set(['availability_lease_v2']),
  }));
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let now = Date.now();
  const at = async <T>(ms: number, run: () => Promise<T>): Promise<T> => {
    now += ms;
    vi.useFakeTimers({ toFake: ['Date'], now });
    try {
      return await run();
    } finally {
      vi.useRealTimers();
    }
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
  const reportAll = async (extra: (id: string) => Partial<AvailabilityLeaseReport> = () => ({})) => {
    for (const id of nodeIds) await service.ingestDaemonReport(id, 'docker', report(id, extra(id)));
    for (const id of [localRelay, remoteRelay]) await service.ingestRelayReport(id, report(id, extra(id)));
  };
  const manifestOf = async (policyId: string) => {
    const [state] = (
      await q('select manifest_block, manifest_version from docker_availability_lease_state where policy_id = $1', [
        policyId,
      ])
    ).rows;
    const value = decodeRelayV1Message(
      'LeaseManifest',
      decodeLeaseSignedBlock(Buffer.from(state.manifest_block, 'base64')).payload
    ) as { candidates: Array<{ id: string }>; closed: boolean; retained?: unknown[] };
    return {
      candidates: value.candidates.map(({ id }) => id),
      closed: value.closed,
      retained: value.retained ?? [],
      version: Number(state.manifest_version),
    };
  };
  const held = (policyId: string, nodeId: string, role: string, round: number) => ({
    held: [
      {
        policyId,
        slot: 0,
        role,
        ballot: { round: String(round), incarnation: '1', proposerId: nodeId },
        epoch: '1',
        manifestVersion: '1',
        placementId: '',
        placementGeneration: '1',
      },
    ],
  });
  /** Acks the current voter epoch of a policy for every member, and lets the joint epoch settle. */
  const settleVoters = async (policyId: string) => {
    for (let round = 0; round < 4; round++) {
      const view = await service.getPolicyLease(policyId);
      if (!view.voterMargin?.joint) return;
      const manifests = [
        {
          policyId,
          manifestVersion: String(view.manifestVersion),
          closed: false,
          voterEpoch: String(view.epoch),
          voter: true,
        },
      ];
      await at(0, () => reportAll(() => ({ manifests })));
      await at(40_000, () => service.reconcile());
    }
  };

  // Migrating a fresh database can take far longer than the default 10 s hook timeout on a loaded runner, and a
  // timed-out hook let the tests run against a half-prepared database (the gates suite failed that way under load).
  beforeAll(async () => {
    database = await disposableDatabase(url!, 'lease_modes');
    pool = database.pool;
    await migrateDatabase(pool);
    const db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    await q(
      `insert into relay_policy_signing_keys (key_id, public_key, public_key_fingerprint, encrypted_private_key,
         encrypted_dek, status, activated_at) values ($1, $2, $3, 'held', 'held', 'active', now())`,
      [keyId, rawPublicKey.toString('base64'), `sha256:${createHash('sha256').update(rawPublicKey).digest('hex')}`]
    );
    await q(`insert into relay_pools (id) values ('system') on conflict do nothing`);
    // The remote relay starts without the lease capability, as right after an upgrade of Gateway alone.
    for (const [id, kind, features] of [
      [localRelay, 'local', ['relay_pool_v1', 'availability_lease_v2']],
      [remoteRelay, 'remote', ['relay_pool_v1']],
    ] as const) {
      await q(
        `insert into relay_instances (id, pool_id, kind, fault_domain_id, display_name, state, capabilities)
         values ($1, 'system', $2, gen_random_uuid(), $4, 'ready', $3)`,
        [id, kind, JSON.stringify({ protocolMajor: 1, features }), `relay-${id}`]
      );
    }
    for (const [index, id] of nodeIds.entries()) {
      await q(
        `insert into nodes (id, type, hostname, slug, status, host_identity_id, capabilities, last_seen_at)
         values ($1, 'docker', $2, $2, 'online', gen_random_uuid(), $3, now())`,
        [id, `mode-node-${index}`, JSON.stringify({ capabilities: ['availability_lease_v2'] })]
      );
    }
    for (const id of [localRelay, remoteRelay, ...nodeIds]) identities.set(id, identityKey());
    for (const [policyId, candidates] of [
      [pairPolicy, nodeIds.slice(0, 2)],
      [triplePolicy, nodeIds],
    ] as const) {
      await q(
        `insert into docker_availability_policies (id, resource_kind, source_node_id, container_name, mode,
           desired_replica_count, status) values ($1, 'container', $2, $3, 'failover', 1, 'healthy')`,
        [policyId, candidates[0], `app-${policyId.slice(0, 8)}`]
      );
      for (const [index, nodeId] of candidates.entries()) {
        await q(
          `insert into docker_availability_placements (policy_id, node_id, generation, desired_state, actual_state,
             serving, spec_fingerprint, created_at) values ($1, $2, 1, $3, $4, $5, 'spec', now() + ($6 || ' seconds')::interval)`,
          [
            policyId,
            nodeId,
            index === 0 ? 'serving' : 'standby',
            index === 0 ? 'serving' : 'ready',
            index === 0,
            String(index),
          ]
        );
      }
    }
    service = new AvailabilityLeaseService(
      db,
      {
        getNode: (id: string) => connected.find((node) => node.nodeId === id),
        getAllNodes: () => connected,
        hasCapability: (id: string, capability: string) =>
          connected.find((node) => node.nodeId === id)?.capabilities.has(capability) ?? false,
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
      { signPayload: async (payload: Buffer) => ({ signingKeyId: keyId, signature: sign(null, payload, privateKey) }) }
    );
    service.attachController({
      leaseModeSupported: () => true,
      leaseModeChanged: async (change) => {
        modeChanges.push(change);
      },
      leaseHolderChanged: async () => undefined,
    });
    await at(0, async () => {
      await reportAll();
      await service.reconcile();
    });
    // Lease mode starts once every participant was ready for 2 minutes without a restart.
    await at(121_000, () => service.reconcile());
  }, 180_000);

  afterAll(async () => {
    vi.useRealTimers();
    await database?.drop();
  }, 60_000);

  it('moves the automatic witness off the local relay once another relay can vote, raising the margin (N-2)', async () => {
    const before = await service.getPolicyLease(pairPolicy);
    expect(before.mode).toBe('bootstrapping');
    // Only the local relay could witness when the policy started: the stand's checkout and payments.
    expect(before.witness).toMatchObject({ memberId: localRelay, kind: 'relay', auto: true });
    expect(before.voters).toEqual([...nodeIds.slice(0, 2), localRelay].sort());
    expect(before.voterMargin).toMatchObject({ voters: 3, reachable: 2, required: 2, margin: 0 });
    // The remote relay is updated: from now on it is the witness, by itself.
    await q(`update relay_instances set capabilities = $2 where id = $1`, [
      remoteRelay,
      JSON.stringify({ protocolMajor: 1, features: ['relay_pool_v1', 'availability_lease_v2'] }),
    ]);
    await at(1_000, () => service.reconcile());
    const joint = await service.getPolicyLease(pairPolicy);
    expect(joint.witness).toMatchObject({ memberId: remoteRelay, auto: true, warning: null });
    expect(joint.voterMargin?.joint).toBe(true);
    await settleVoters(pairPolicy);
    const settled = await at(0, async () => {
      await reportAll();
      return service.getPolicyLease(pairPolicy, new Date());
    });
    expect(settled.voters).toEqual([...nodeIds.slice(0, 2), remoteRelay].sort());
    expect(settled.voterMargin).toMatchObject({ joint: false, voters: 3, reachable: 3, required: 2, margin: 1 });
    // No churn afterwards: the next runs keep the same voters and manifest.
    const version = (await manifestOf(pairPolicy)).version;
    await at(1_000, () => service.reconcile());
    await at(1_000, () => service.reconcile());
    expect((await manifestOf(pairPolicy)).version).toBe(version);
    // The three-candidate policy needs no witness at all.
    expect((await service.getPolicyLease(triplePolicy)).witness).toMatchObject({ memberId: null });
  });

  it('lists an outdated daemon as excluded at once and drops it from voters and manifest only after 2 minutes (D3)', async () => {
    const outdated = nodeIds[2]!;
    const changes = modeChanges.length;
    const before = await manifestOf(triplePolicy);
    expect(before.candidates).toContain(outdated);
    connected[2]!.capabilities = new Set(['availability_lease_v1']);
    await at(1_000, () => service.reconcile());
    const early = await service.getPolicyLease(triplePolicy);
    expect(early.excludedNodes).toEqual([{ nodeId: outdated, reason: 'daemon_outdated' }]);
    expect(early.reason).toBeNull();
    // Inside the grace a rolling update changes nothing: same voters, same manifest.
    expect((await manifestOf(triplePolicy)).version).toBe(before.version);
    expect(early.voters).toContain(outdated);
    await at(121_000, () => service.reconcile());
    const after = await service.getPolicyLease(triplePolicy);
    expect((await manifestOf(triplePolicy)).candidates).toEqual(nodeIds.slice(0, 2));
    // The voters are re-picked from v2 members: the two candidates plus a witness, which is not the local relay.
    expect(after.voterMargin?.joint).toBe(true);
    expect(after.witness).toMatchObject({ memberId: remoteRelay });
    expect(after.mode).toBe(early.mode);
    expect(modeChanges).toHaveLength(changes);
    await settleVoters(triplePolicy);
    expect((await service.getPolicyLease(triplePolicy)).voters).toEqual([...nodeIds.slice(0, 2), remoteRelay].sort());
    // Updated again: back in the manifest at once.
    connected[2]!.capabilities = new Set(['availability_lease_v2']);
    await at(1_000, () => service.reconcile());
    expect((await manifestOf(triplePolicy)).candidates).toEqual(nodeIds);
    expect((await service.getPolicyLease(triplePolicy)).excludedNodes).toEqual([]);
    await settleVoters(triplePolicy);
  });

  it('never cuts an outdated node that holds a slot from the manifest: removal would fence it', async () => {
    const holder = nodeIds[1]!;
    await at(1_000, async () => {
      await service.ingestDaemonReport(holder, 'docker', report(holder, held(triplePolicy, holder, 'holding', 5)));
      await service.reconcile();
    });
    expect((await service.getPolicyLease(triplePolicy)).holders[0]).toMatchObject({ holderNodeId: holder });
    connected[1]!.capabilities = new Set(['availability_lease_v1']);
    await at(1_000, () => service.reconcile());
    await at(121_000, async () => {
      await service.ingestDaemonReport(holder, 'docker', report(holder, held(triplePolicy, holder, 'holding', 6)));
      await service.reconcile();
    });
    expect((await manifestOf(triplePolicy)).candidates).toContain(holder);
    expect((await service.getPolicyLease(triplePolicy)).excludedNodes).toEqual([
      { nodeId: holder, reason: 'daemon_outdated' },
    ]);
    connected[1]!.capabilities = new Set(['availability_lease_v2']);
  });

  it('drops a fenced holder from the claimants once it no longer reports the key', async () => {
    const holder = nodeIds[1]!;
    const claimants = async () =>
      (
        await q('select holder_id, claimants from docker_availability_lease_observations where policy_id = $1', [
          triplePolicy,
        ])
      ).rows[0];
    await at(1_000, () =>
      service.ingestDaemonReport(holder, 'docker', report(holder, held(triplePolicy, holder, 'abandoned', 6)))
    );
    expect(await claimants()).toMatchObject({ holder_id: null, claimants: { [holder]: { role: 'abandoned' } } });
    await at(1_000, () => service.ingestDaemonReport(holder, 'docker', report(holder)));
    const after = await claimants();
    expect(after.holder_id).toBeNull();
    expect(after.claimants).toEqual({});
  });

  it('closes at once on an explicit request and waits for every lease to expire before legacy (A5, D3)', async () => {
    await at(1_000, () => service.setLegacyRequested(triplePolicy, true));
    const closing = await service.getPolicyLease(triplePolicy);
    expect(closing.mode).toBe('closing');
    expect(closing.reason).toEqual({
      code: 'legacy_requested',
      message: 'The Availability controller runs this policy on the backend path',
    });
    expect((await manifestOf(triplePolicy)).closed).toBe(true);
    const closed = [{ policyId: triplePolicy, manifestVersion: String(closing.manifestVersion), closed: true }];
    // Closing from bootstrapping names the reserved holder with an empty ballot (graceful close).
    expect((await manifestOf(triplePolicy)).retained).toEqual([{ slot: 0, holderId: nodeIds[0], ballot: null }]);
    // Its bootstrap commit raced the close and it cannot get the close confirmed: it holds, never retained. A voter
    // majority of every quorum set persisted the close; the third candidate is gone and never acks.
    await at(1_000, async () => {
      await service.ingestDaemonReport(
        nodeIds[0]!,
        'docker',
        report(nodeIds[0]!, { manifests: closed, ...held(triplePolicy, nodeIds[0]!, 'holding', 20) })
      );
      await service.ingestDaemonReport(nodeIds[1]!, 'docker', report(nodeIds[1]!, { manifests: closed }));
      await service.ingestRelayReport(remoteRelay, report(remoteRelay, { manifests: closed }));
      await service.reconcile();
    });
    expect((await service.getPolicyLease(triplePolicy)).mode).toBe('closing');
    await at(40_000, () => service.reconcile());
    expect((await service.getPolicyLease(triplePolicy)).mode).toBe('closing');
    // T x 1.1 / 0.9 plus the fence stop margin after the majority ack: every lease has expired.
    await at(7_000, () => service.reconcile());
    expect((await service.getPolicyLease(triplePolicy)).mode).toBe('legacy');
    expect(modeChanges.at(-1)).toMatchObject({
      policyId: triplePolicy,
      to: 'legacy',
      retainedHolders: [],
      lastHolders: [{ slot: 0, holderId: nodeIds[0] }],
    });
  });
});
