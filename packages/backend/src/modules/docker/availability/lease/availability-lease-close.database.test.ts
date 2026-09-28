import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import type { AvailabilityLeaseReport } from '@/grpc/generated/types.js';
import { AvailabilityLeaseService } from './availability-lease.service.js';
import { leaseManifestClosure } from './lease-codec.js';
import { CLOSE_SETTLE_MS } from './lease-constants.js';
import type { DockerAvailabilityLeaseModeChange } from './lease-types.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;

// Each test runs several reconciles against PostgreSQL; a loaded runner must not turn that into a timeout.
vi.setConfig({ testTimeout: 60_000 });

function identityKey(): Buffer {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
}

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): graceful close on PostgreSQL. Leaving lease mode (a disable or
 * lifecycle hold, the 2-minute impossibility exits) never stops the serving copy: the closed manifest names the
 * committed holder as retained, and once it reports that a majority confirmed the close, legacy adopts it as running
 * without waiting for the lease to expire. A holder that cannot confirm (partitioned) expires and legacy heals it.
 */
describe.skipIf(!url)('availability lease graceful close on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let service: AvailabilityLeaseService;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  const keyId = randomUUID();
  const relayId = randomUUID();
  const dockerIds = [randomUUID(), randomUUID(), randomUUID()];
  const nginxId = randomUUID();
  const policyId = randomUUID();
  const identities = new Map<string, Buffer>();
  const modeChanges: DockerAvailabilityLeaseModeChange[] = [];
  let now = Date.now();
  let round = 10;
  const connected = [...dockerIds.map((id) => ({ id, type: 'docker' })), { id: nginxId, type: 'nginx' }].map(
    ({ id, type }) => ({
      nodeId: id,
      connectionId: `c-${id}`,
      type,
      capabilities: new Set(['availability_lease_v2']),
      connectedAt: new Date(now - 3_600_000),
    })
  );
  const nginx = connected.find(({ nodeId }) => nodeId === nginxId)!;
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
  const nginxReport = (): AvailabilityLeaseReport => ({
    ...report(nginxId),
    memberId: '',
    identityPublicKey: Buffer.alloc(0),
    incarnation: '0',
    watchdogReady: false,
  });
  const held = (nodeId: string, role: string, ballotRound: number, retained = false) => ({
    held: [
      {
        policyId,
        slot: 0,
        role,
        ballot: { round: String(ballotRound), incarnation: '1', proposerId: nodeId },
        epoch: '1',
        manifestVersion: '1',
        placementId: '',
        placementGeneration: '1',
        ...(retained ? { retained: true } : {}),
      },
    ],
  });
  const closedAck = (version: number) => ({
    manifests: [{ policyId, manifestVersion: String(version), closed: true }],
  });
  /** Every member's heartbeat; extra per member id. */
  const heartbeat = async (extra: (id: string) => Partial<AvailabilityLeaseReport> = () => ({})) => {
    for (const id of dockerIds) await service.ingestDaemonReport(id, 'docker', report(id, extra(id)));
    await service.ingestDaemonReport(nginxId, 'nginx', nginxReport());
    await service.ingestRelayReport(relayId, report(relayId, extra(relayId)));
  };
  const view = () => service.getPolicyLease(policyId, new Date(now));
  const closure = async () => {
    const [state] = (
      await q('select manifest_block, manifest_version from docker_availability_lease_state where policy_id = $1', [
        policyId,
      ])
    ).rows;
    return { ...leaseManifestClosure(state.manifest_block), version: Number(state.manifest_version) };
  };
  /** Back into lease mode with dockerIds[0] holding slot 0 (re-entry hold, participants settled, gate window). */
  const enterLease = async () => {
    for (let attempt = 0; attempt < 6 && (await view()).mode === 'legacy'; attempt++) {
      await at(61_000, async () => {
        await heartbeat();
        await service.reconcile();
      });
    }
    expect((await view()).mode).toBe('bootstrapping');
    round += 1;
    const holding = (id: string) => (id === dockerIds[0] ? held(id, 'holding', round) : {});
    await at(1_000, async () => {
      await heartbeat(holding);
      await service.reconcile();
    });
    await at(25_000, async () => {
      await heartbeat(holding);
      await service.reconcile();
    });
    expect(await view()).toMatchObject({ mode: 'lease', holders: [{ slot: 0, holderNodeId: dockerIds[0] }] });
  };

  // Migrating a fresh database can take far longer than the default 10 s hook timeout on a loaded runner.
  beforeAll(async () => {
    database = await disposableDatabase(url!, 'lease_close');
    pool = database.pool;
    await migrateDatabase(pool);
    const db = drizzle(pool, { schema }) as unknown as DrizzleClient;
    await q(
      `insert into relay_policy_signing_keys (key_id, public_key, public_key_fingerprint, encrypted_private_key,
         encrypted_dek, status, activated_at) values ($1, $2, $3, 'held', 'held', 'active', now())`,
      [keyId, rawPublicKey.toString('base64'), `sha256:${createHash('sha256').update(rawPublicKey).digest('hex')}`]
    );
    await q(`insert into relay_pools (id) values ('system') on conflict do nothing`);
    await q(
      `insert into relay_instances (id, pool_id, kind, fault_domain_id, display_name, state, capabilities)
       values ($1, 'system', 'local', gen_random_uuid(), 'local', 'ready', $2)`,
      [relayId, JSON.stringify({ protocolMajor: 1, features: ['relay_pool_v1', 'availability_lease_v2'] })]
    );
    for (const [index, id] of [...dockerIds, nginxId].entries()) {
      await q(
        `insert into nodes (id, type, hostname, slug, status, host_identity_id, capabilities, last_seen_at)
         values ($1, $2, $3, $3, 'online', gen_random_uuid(), $4, now())`,
        [
          id,
          id === nginxId ? 'nginx' : 'docker',
          `close-node-${index}`,
          JSON.stringify({ capabilities: ['availability_lease_v2'] }),
        ]
      );
    }
    for (const id of [relayId, ...dockerIds]) identities.set(id, identityKey());
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
    await q('insert into permission_groups (id, name) values ($1, $2)', [group, `close-${group}`]);
    await q("insert into users (id, group_id, email, name) values ($1, $2, $3, 'Close')", [
      user,
      group,
      `${user}@close.test`,
    ]);
    const hostId = randomUUID();
    await q(`insert into proxy_hosts (id, slug, created_by_id) values ($1, 'close-host', $2)`, [hostId, user]);
    await q(
      `insert into proxy_additional_secure_links (id, proxy_host_id, name, purpose, reference_id,
         availability_owner_key, upstream_kind, source_node_id, docker_node_id, docker_container_port,
         docker_host_port, target_container, status)
       values ($1, $2, 'member', 'availability_member', $3, $4, 'docker_container', $5, $6, 80, 8080, 'web', 'active')`,
      [randomUUID(), hostId, placement.id, `proxy-host:${hostId}`, nginxId, dockerIds[0]]
    );
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
      {
        signPayload: async (payload: Buffer) => ({ signingKeyId: keyId, signature: sign(null, payload, privateKey) }),
      }
    );
    service.attachController({
      leaseModeSupported: () => true,
      leaseModeChanged: async (change) => {
        modeChanges.push(change);
      },
      leaseHolderChanged: async () => undefined,
    });
    await at(0, async () => {
      await heartbeat();
      await service.reconcile();
    });
    await at(121_000, () => service.reconcile());
    await enterLease();
  }, 180_000);

  afterAll(async () => {
    vi.useRealTimers();
    await database?.drop();
  }, 60_000);

  it('keeps the copy of a disable or lifecycle hold running and hands it to legacy as running at once', async () => {
    const changes = modeChanges.length;
    const ballot = { round: String(round), incarnation: '1', proposerId: dockerIds[0] };
    // A disable (or a stop/start/restart) holds the policy on the legacy path: it closes at once.
    await at(1_000, () => service.setLegacyRequested(policyId, true));
    const closing = await view();
    expect(closing.mode).toBe('closing');
    expect(closing.retainedHolders).toEqual([{ slot: 0, holderNodeId: dockerIds[0], confirmed: false }]);
    const published = await closure();
    expect(published).toMatchObject({ closed: true, retained: [{ slot: 0, holderId: dockerIds[0], ballot }] });
    // The retained holders stay the same for the whole close: later reconciles republish nothing.
    await at(1_000, async () => {
      await heartbeat((id) => (id === dockerIds[0] ? held(id, 'holding', round) : {}));
      await service.reconcile();
    });
    expect((await closure()).version).toBe(published.version);
    // A former holder whose copy still stops keeps legacy waiting, even with the retained holder confirmed.
    await at(1_000, async () => {
      await heartbeat((id) =>
        id === dockerIds[0]
          ? { ...held(id, 'retained', round, true), ...closedAck(published.version) }
          : id === dockerIds[1]
            ? { ...held(id, 'fencing', round - 1), ...closedAck(published.version) }
            : closedAck(published.version)
      );
      await service.reconcile();
    });
    const confirmed = await view();
    expect(confirmed.mode).toBe('closing');
    expect(confirmed.retainedHolders).toEqual([{ slot: 0, holderNodeId: dockerIds[0], confirmed: true }]);
    // The fenced copy is gone: legacy takes over right away, long before the lease could have expired.
    await at(1_000, async () => {
      await heartbeat((id) =>
        id === dockerIds[0]
          ? { ...held(id, 'retained', round, true), ...closedAck(published.version) }
          : closedAck(published.version)
      );
      await service.reconcile();
    });
    expect((await view()).mode).toBe('legacy');
    expect(modeChanges.slice(changes).map(({ from, to }) => `${from}->${to}`)).toEqual([
      'lease->closing',
      'closing->legacy',
    ]);
    expect(modeChanges.at(-1)).toMatchObject({
      retainedHolders: [{ slot: 0, holderId: dockerIds[0] }],
      lastHolders: [{ slot: 0, holderId: dockerIds[0] }],
    });
    expect(modeChanges.at(-2)).toMatchObject({ retainedHolders: [] });
    await at(1_000, () => service.setLegacyRequested(policyId, false));
    await enterLease();
  });

  it('leaves lease mode after 2 minutes of an ingress nginx node without v2, keeping the copy running', async () => {
    const changes = modeChanges.length;
    nginx.capabilities = new Set(['availability_lease_v1']);
    try {
      await at(1_000, async () => {
        await heartbeat((id) => (id === dockerIds[0] ? held(id, 'holding', round) : {}));
        await service.reconcile();
      });
      expect(await view()).toMatchObject({ mode: 'lease', reason: { code: 'ingress_not_capable' } });
      await at(121_000, async () => {
        await heartbeat((id) => (id === dockerIds[0] ? held(id, 'holding', round) : {}));
        await service.reconcile();
      });
      expect(await view()).toMatchObject({
        mode: 'closing',
        retainedHolders: [{ slot: 0, holderNodeId: dockerIds[0], confirmed: false }],
      });
      const version = (await closure()).version;
      await at(1_000, async () => {
        await heartbeat((id) =>
          id === dockerIds[0] ? { ...held(id, 'retained', round, true), ...closedAck(version) } : closedAck(version)
        );
        await service.reconcile();
      });
      expect((await view()).mode).toBe('legacy');
      expect(modeChanges.slice(changes).map(({ to }) => to)).toEqual(['closing', 'legacy']);
      expect(modeChanges.at(-1)).toMatchObject({ retainedHolders: [{ slot: 0, holderId: dockerIds[0] }] });
    } finally {
      nginx.capabilities = new Set(['availability_lease_v2']);
    }
    await enterLease();
  });

  it('lets a partitioned holder expire and gives the slot to the legacy heal after the settle time', async () => {
    const changes = modeChanges.length;
    await at(1_000, () => service.setLegacyRequested(policyId, true));
    const version = (await closure()).version;
    expect((await view()).retainedHolders).toEqual([{ slot: 0, holderNodeId: dockerIds[0], confirmed: false }]);
    // The holder is cut off: it never confirms the close (it fences at its renewal timeout). The other voters
    // persisted the close, so no renewal can succeed any more.
    await at(1_000, async () => {
      for (const id of dockerIds.slice(1))
        await service.ingestDaemonReport(id, 'docker', report(id, closedAck(version)));
      await service.ingestRelayReport(relayId, report(relayId, closedAck(version)));
      await service.reconcile();
    });
    expect((await view()).mode).toBe('closing');
    await at(CLOSE_SETTLE_MS - 5_000, () => service.reconcile());
    expect((await view()).mode).toBe('closing');
    await at(6_000, () => service.reconcile());
    expect((await view()).mode).toBe('legacy');
    expect(modeChanges.slice(changes).map(({ to }) => to)).toEqual(['closing', 'legacy']);
    // Not retained: legacy adopts it as a stopped last holder and its heal starts the slot again.
    expect(modeChanges.at(-1)).toMatchObject({
      retainedHolders: [],
      lastHolders: [{ slot: 0, holderId: dockerIds[0] }],
    });
  });
});
