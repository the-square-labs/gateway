import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import type { AvailabilityLeaseReport } from '@/grpc/generated/types.js';
import { AvailabilityLeaseService } from './availability-lease.service.js';
import type { DockerAvailabilityLeaseModeChange } from './lease-types.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;

// Each test runs several reconciles against PostgreSQL; a loaded runner must not turn that into a timeout.
vi.setConfig({ testTimeout: 60_000 });

function identityKey(): Buffer {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
}

const V1 = ['availability_lease_v1'];
const V2 = ['availability_lease_v2'];

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): the normal production upgrade order, Gateway (with its local relay)
 * first and the nodes one by one afterwards (harness run cand-rc19-to-rc20pre: ha-web entered lease mode in the middle
 * of the node rollout). A legacy policy enters lease mode only once every participant ran availability_lease_v2 for
 * 2 minutes without a restart; a lease-mode policy keeps its lease, voters and manifest through such a rollout.
 */
describe.skipIf(!url)('availability lease across a rolling upgrade on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  const keyId = randomUUID();
  const localRelay = randomUUID();
  const dockerIds = [randomUUID(), randomUUID(), randomUUID()];
  const nginxId = randomUUID();
  const policyId = randomUUID();
  const identities = new Map<string, Buffer>();
  const incarnations = new Map<string, number>();
  const modeChanges: DockerAvailabilityLeaseModeChange[] = [];
  let now = Date.now();
  const connected = [...dockerIds.map((id) => ({ id, type: 'docker' })), { id: nginxId, type: 'nginx' }].map(
    ({ id, type }) => ({
      nodeId: id,
      connectionId: `c-${id}`,
      type,
      capabilities: new Set(V1),
      connectedAt: new Date(now - 3_600_000),
    })
  );
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
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
    incarnation: String(incarnations.get(memberId) ?? 1),
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
  const nginxReport = (): AvailabilityLeaseReport => ({
    ...report(nginxId),
    memberId: '',
    identityPublicKey: Buffer.alloc(0),
    incarnation: '0',
    watchdogReady: false,
  });
  const heartbeat = async (extra: (id: string) => Partial<AvailabilityLeaseReport> = () => ({})) => {
    for (const id of dockerIds) await service.ingestDaemonReport(id, 'docker', report(id, extra(id)));
    await service.ingestDaemonReport(nginxId, 'nginx', nginxReport());
    await service.ingestRelayReport(localRelay, report(localRelay, extra(localRelay)));
  };
  /** A node restarts on the new version: new control connection, new lease incarnation, v2 advertised. */
  const updateNode = (id: string) => {
    const node = connected.find(({ nodeId }) => nodeId === id)!;
    node.capabilities = new Set(V2);
    node.connectedAt = new Date(now);
    incarnations.set(id, (incarnations.get(id) ?? 1) + 1);
  };
  const restartNode = (id: string) => {
    const node = connected.find(({ nodeId }) => nodeId === id)!;
    node.connectedAt = new Date(now);
    incarnations.set(id, (incarnations.get(id) ?? 1) + 1);
  };
  const state = async () =>
    (
      await q('select mode, manifest_version, quorum_sets from docker_availability_lease_state where policy_id = $1', [
        policyId,
      ])
    ).rows[0] as { mode: string; manifest_version: string; quorum_sets: string[][] };
  let service: AvailabilityLeaseService;
  const newService = () => {
    const created = new AvailabilityLeaseService(
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
      {
        signPayload: async (payload: Buffer) => ({ signingKeyId: keyId, signature: sign(null, payload, privateKey) }),
      }
    );
    created.attachController({
      leaseModeSupported: () => true,
      leaseModeChanged: async (change) => {
        modeChanges.push(change);
      },
      leaseHolderChanged: async () => undefined,
    });
    return created;
  };

  // Migrating a fresh database can take far longer than the default 10 s hook timeout on a loaded runner, and a
  // timed-out hook let the tests run against a half-prepared database (the gates suite failed that way under load).
  beforeAll(async () => {
    database = await disposableDatabase(url!, 'lease_upgrade');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    await q(
      `insert into relay_policy_signing_keys (key_id, public_key, public_key_fingerprint, encrypted_private_key,
         encrypted_dek, status, activated_at) values ($1, $2, $3, 'held', 'held', 'active', now())`,
      [keyId, rawPublicKey.toString('base64'), `sha256:${createHash('sha256').update(rawPublicKey).digest('hex')}`]
    );
    await q(`insert into relay_pools (id) values ('system') on conflict do nothing`);
    // Gateway and its local relay are on the new version already; the nodes are not.
    await q(
      `insert into relay_instances (id, pool_id, kind, fault_domain_id, display_name, state, capabilities)
       values ($1, 'system', 'local', gen_random_uuid(), 'local', 'ready', $2)`,
      [localRelay, JSON.stringify({ protocolMajor: 1, features: ['relay_pool_v1', ...V2] })]
    );
    for (const [index, id] of [...dockerIds, nginxId].entries()) {
      await q(
        `insert into nodes (id, type, hostname, slug, status, host_identity_id, capabilities, last_seen_at)
         values ($1, $2, $3, $3, 'online', gen_random_uuid(), $4, now())`,
        [id, id === nginxId ? 'nginx' : 'docker', `upgrade-node-${index}`, JSON.stringify({ capabilities: V1 })]
      );
    }
    for (const id of [localRelay, ...dockerIds]) identities.set(id, identityKey());
    await q(
      `insert into docker_availability_policies (id, resource_kind, source_node_id, container_name, mode,
         desired_replica_count, status) values ($1, 'container', $2, 'web', 'failover', 1, 'healthy')`,
      [policyId, dockerIds[0]]
    );
    for (const [index, id] of dockerIds.entries()) {
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
    // The route's ingress nginx node: a member Secure Link of the serving placement, sourced on it.
    const [placement] = (
      await q('select id from docker_availability_placements where policy_id = $1 and node_id = $2', [
        policyId,
        dockerIds[0],
      ])
    ).rows;
    const group = randomUUID();
    const user = randomUUID();
    await q('insert into permission_groups (id, name) values ($1, $2)', [group, `upgrade-${group}`]);
    await q("insert into users (id, group_id, email, name) values ($1, $2, $3, 'Upgrade')", [
      user,
      group,
      `${user}@upgrade.test`,
    ]);
    const hostId = randomUUID();
    await q(`insert into proxy_hosts (id, slug, created_by_id) values ($1, 'upgrade-host', $2)`, [hostId, user]);
    await q(
      `insert into proxy_additional_secure_links (id, proxy_host_id, name, purpose, reference_id,
         availability_owner_key, upstream_kind, source_node_id, docker_node_id, docker_container_port,
         docker_host_port, target_container, status)
       values ($1, $2, 'member', 'availability_member', $3, $4, 'docker_container', $5, $6, 80, 8080, 'web', 'active')`,
      [randomUUID(), hostId, placement.id, `proxy-host:${hostId}`, nginxId, dockerIds[0]]
    );
    service = newService();
  }, 180_000);

  afterAll(async () => {
    vi.useRealTimers();
    await database?.drop();
  }, 60_000);

  it('enters lease mode only after the whole fleet ran v2 for 2 minutes, restarts included (Gateway first)', async () => {
    const step = async (ms: number, change?: () => void) =>
      at(ms, async () => {
        change?.();
        await heartbeat();
        await service.reconcile();
        return service.getPolicyLease(policyId);
      });
    // Gateway upgraded, every node still on the old version: legacy with the reason.
    expect(await step(0)).toMatchObject({ mode: 'legacy', reason: { code: 'candidates_not_capable' } });
    // The nodes are updated one by one; none of the intermediate states may start the lease.
    expect((await step(30_000, () => updateNode(dockerIds[0]!))).mode).toBe('legacy');
    expect((await step(30_000, () => updateNode(dockerIds[1]!))).mode).toBe('legacy');
    expect((await step(30_000, () => updateNode(dockerIds[2]!))).reason).toMatchObject({
      code: 'ingress_not_capable',
    });
    const settling = await step(10_000, () => updateNode(nginxId));
    expect(settling).toMatchObject({ mode: 'legacy', reason: { code: 'participants_settling' } });
    expect(settling.reason?.nodeIds).toEqual([...dockerIds, nginxId].sort());
    // A daemon restarts once more during the rollout: its 2 minutes start again.
    await step(60_000, () => restartNode(dockerIds[1]!));
    const waiting = await step(70_000);
    expect(waiting).toMatchObject({ mode: 'legacy', reason: { code: 'participants_settling' } });
    expect(waiting.reason?.nodeIds).toEqual([dockerIds[1]]);
    expect(Number((await state()).manifest_version)).toBe(0);
    expect(modeChanges).toHaveLength(0);
    // Two minutes after that restart the fleet is settled: lease mode starts, once.
    const started = await step(51_000);
    expect(started.mode).toBe('bootstrapping');
    expect(started.reason).toBeNull();
    expect(modeChanges.map(({ from, to }) => `${from}->${to}`)).toEqual(['legacy->bootstrapping']);
  });

  it('keeps a lease-mode policy, its voters and its manifest while the nodes are updated after Gateway', async () => {
    // The reserved holder acquires and the gate window passes: lease mode.
    const held = {
      held: [
        {
          policyId,
          slot: 0,
          role: 'holding',
          ballot: { round: '3', incarnation: '1', proposerId: dockerIds[0]! },
          epoch: '1',
          manifestVersion: '1',
          placementId: '',
          placementGeneration: '1',
        },
      ],
    };
    await at(1_000, async () => {
      await heartbeat((id) => (id === dockerIds[0] ? held : {}));
      await service.reconcile();
    });
    await at(25_000, async () => {
      await heartbeat((id) => (id === dockerIds[0] ? held : {}));
      await service.reconcile();
    });
    expect((await service.getPolicyLease(policyId)).mode).toBe('lease');
    const before = await state();
    const changes = modeChanges.length;
    // The next release: Gateway restarts first (a fresh process) while every node still advertises the old version.
    service = newService();
    for (const node of connected) node.capabilities = new Set(V1);
    const step = async (ms: number, change?: () => void) =>
      at(ms, async () => {
        change?.();
        await heartbeat((id) => (id === dockerIds[0] ? held : {}));
        await service.reconcile();
        return service.getPolicyLease(policyId);
      });
    const first = await step(1_000);
    expect(first.mode).toBe('lease');
    expect(first.reason).toMatchObject({ code: 'ingress_not_capable', since: expect.any(String) });
    expect(first.excludedNodes.map(({ reason }) => reason)).toEqual([
      'daemon_outdated',
      'daemon_outdated',
      'daemon_outdated',
    ]);
    for (const id of [...dockerIds, nginxId]) {
      const view = await step(20_000, () => updateNode(id));
      expect(view.mode).toBe('lease');
    }
    const after = await step(20_000);
    expect(after).toMatchObject({ mode: 'lease', reason: null, excludedNodes: [] });
    // No mode change, the same voters, the same manifest: the rollout was invisible to the lease.
    expect(modeChanges).toHaveLength(changes);
    const current = await state();
    expect(current.quorum_sets).toEqual(before.quorum_sets);
    expect(current.manifest_version).toBe(before.manifest_version);
  });
});
