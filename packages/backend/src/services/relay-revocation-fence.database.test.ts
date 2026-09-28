import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase, pgError } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import {
  relayEndpoints,
  relayInstancePolicyState,
  relayInstances,
  relayPolicyState,
  relayPools,
  relayRoutes,
} from '@/db/schema/index.js';
import { bumpRelayPolicyRevision } from './relay-policy-reconciler.js';
import { type BuiltPolicyRoute, RELAY_REVOCATION_ACK_TIMEOUT_MS } from './relay-revocation-fence.js';
import {
  loadInstancePolicyState,
  loadRevocationFenceState,
  RELAY_POLICY_REVISION_LOCK,
  RelayRevocationFenceService,
  recordBuiltSnapshot,
} from './relay-revocation-fence.service.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;
type Transaction = Parameters<Parameters<DrizzleClient['transaction']>[0]>[0];
const T0 = Date.parse('2026-09-27T10:00:00.000Z');

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL, see migration-database.test-helpers): the route history column and the
 * jsonpath filters the revocation fence relies on, against a real PostgreSQL.
 */
describe.skipIf(!url)('relay revocation fence on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let db: DrizzleClient;
  const endpointId = randomUUID();
  const keptRouteId = randomUUID();
  const revokedRouteId = randomUUID();
  const relayId = randomUUID();

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'revocation');
    await migrateDatabase(database.pool);
    db = drizzle(database.pool, { schema }) as unknown as DrizzleClient;
    await db.insert(relayPools).values({ id: 'system', desiredPolicyRevision: 10 }).onConflictDoNothing();
    await db
      .insert(relayPolicyState)
      .values({ id: 'current', gatewayInstanceId: randomUUID(), revision: 5 })
      .onConflictDoUpdate({ target: relayPolicyState.id, set: { revision: 5 } });
    await db.insert(relayInstances).values({
      id: relayId,
      poolId: 'system',
      kind: 'remote',
      faultDomainId: randomUUID(),
      displayName: 'edge-1',
      appliedPolicyRevision: 10,
    });
    await db.insert(relayEndpoints).values({
      id: endpointId,
      ownerKind: 'proxy_host_secure_link',
      ownerId: randomUUID(),
      subjectKind: 'daemon',
      subjectId: 'node-target',
      certificateSha256: 'sha256:target',
    });
    for (const id of [keptRouteId, revokedRouteId]) {
      await db.insert(relayRoutes).values({
        id,
        ownerKind: 'proxy_host_secure_link',
        ownerId: id,
        sourceKind: 'daemon',
        sourceId: 'node-source',
        sourceCertificateSha256: 'sha256:source',
        targetEndpointId: endpointId,
      });
    }
  }, 180_000);

  /** What a snapshot build records, under the revision lock the caller holds. */
  async function recordBuild(tx: Transaction, built: BuiltPolicyRoute[], revision: number) {
    const previous = await loadInstancePolicyState(tx, relayId);
    await recordBuiltSnapshot(tx, relayId, previous, built, {
      key: `content-${revision}`,
      revision,
      issuedAtUnix: 0,
      expiresAtUnix: 0,
    });
  }

  afterAll(async () => {
    await database?.drop();
  });

  it('fences a relay that missed a revocation and clears it once the relay applies the revoking revision', async () => {
    const tuple = (routeId: string) => ({ routeId, endpointId, routeGeneration: 1, endpointGeneration: 1 });
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${RELAY_POLICY_REVISION_LOCK}))`);
      await recordBuild(tx, [tuple(keptRouteId), tuple(revokedRouteId)], 10);
    });
    // The relay goes silent; Gateway revokes one route and bumps the policy revision.
    await db.delete(relayRoutes).where(eq(relayRoutes.id, revokedRouteId));
    await db.update(relayPolicyState).set({ revision: 6 }).where(eq(relayPolicyState.id, 'current'));

    const service = new RelayRevocationFenceService(db);
    expect((await service.evaluate(new Date(T0))).transitions).toEqual([]);
    const stale = await service.evaluate(new Date(T0 + RELAY_REVOCATION_ACK_TIMEOUT_MS));
    expect(stale.transitions).toMatchObject([{ instanceId: relayId, stale: true, staleRoutes: 1 }]);
    expect(stale.nodeIds).toEqual(['node-target']);

    const fences = await loadRevocationFenceState(db);
    expect([...fences.staleRelaysByRoute]).toEqual([[revokedRouteId, new Set([relayId])]]);
    expect(await fences.fencesForEndpoints([endpointId])).toEqual([
      { relayInstanceId: relayId, endpointId, routes: [{ routeId: revokedRouteId, allowedGeneration: '0' }] },
    ]);

    // The first revision issued after the revocation was recorded is 11.
    await db.update(relayPools).set({ desiredPolicyRevision: 11 }).where(eq(relayPools.id, 'system'));
    await db.update(relayInstances).set({ appliedPolicyRevision: 11 }).where(eq(relayInstances.id, relayId));
    const cleared = await service.evaluate(new Date(T0 + 2 * RELAY_REVOCATION_ACK_TIMEOUT_MS));
    expect(cleared.transitions).toMatchObject([{ instanceId: relayId, stale: false, staleRoutes: 0 }]);
    expect((await loadRevocationFenceState(db)).staleRelaysByRoute.size).toBe(0);
    const [history] = await db
      .select()
      .from(relayInstancePolicyState)
      .where(eq(relayInstancePolicyState.instanceId, relayId));
    expect(history?.routes).toEqual([tuple(keptRouteId)]);
  });

  /**
   * B3 regression: a snapshot build (revision lock, relay_policy_state FOR SHARE, route history
   * write) interleaved with a pool reconcile transaction (relay_instances update, then policy
   * revision bump). Both must commit; the same interleaving with a relay_instances write in the
   * build deadlocks, which proves the interleaving is forced.
   */
  async function interleave(buildWrite: (tx: Transaction) => Promise<unknown>) {
    let buildLocked!: () => void;
    let reconcileLocked!: () => void;
    const buildHolds = new Promise<void>((resolve) => {
      buildLocked = resolve;
    });
    const reconcileHolds = new Promise<void>((resolve) => {
      reconcileLocked = resolve;
    });
    const build = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${RELAY_POLICY_REVISION_LOCK}))`);
      await tx.select().from(relayPolicyState).where(eq(relayPolicyState.id, 'current')).for('share');
      buildLocked();
      await reconcileHolds;
      await tx
        .update(relayPools)
        .set({ desiredPolicyRevision: sql`${relayPools.desiredPolicyRevision} + 1` })
        .where(eq(relayPools.id, 'system'));
      await buildWrite(tx);
    });
    const reconcile = db.transaction(async (tx) => {
      await tx.update(relayInstances).set({ updatedAt: new Date() }).where(eq(relayInstances.id, relayId));
      reconcileLocked();
      await buildHolds;
      await bumpRelayPolicyRevision(tx);
    });
    return Promise.allSettled([build, reconcile]);
  }

  it('lets a snapshot build and a pool reconcile interleave without a deadlock', async () => {
    const tuple = (routeId: string, generation: number) => ({
      routeId,
      endpointId,
      routeGeneration: generation,
      endpointGeneration: 1,
    });
    for (let generation = 2; generation < 6; generation++) {
      const results = await interleave((tx) => recordBuild(tx, [tuple(keptRouteId, generation)], 20 + generation));
      expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
    }
    const control = await interleave((tx) =>
      tx.update(relayInstances).set({ displayName: 'edge-1' }).where(eq(relayInstances.id, relayId))
    );
    expect(control.some((result) => result.status === 'rejected' && pgError(result.reason)?.code === '40P01')).toBe(
      true
    );
  });

  it('prunes the bookkeeping of removed relays', async () => {
    const removed = randomUUID();
    await db.insert(relayInstancePolicyState).values({ instanceId: removed, routes: [] });
    await db.update(relayPolicyState).set({ revision: sql`${relayPolicyState.revision} + 1` });
    await new RelayRevocationFenceService(db).evaluate(new Date(T0));
    const rows = await db
      .select({ id: relayInstancePolicyState.instanceId })
      .from(relayInstancePolicyState)
      .where(eq(relayInstancePolicyState.instanceId, removed));
    expect(rows).toEqual([]);
  });

  it('carries the route history of relays out of relay_instances on upgrade', async () => {
    const upgrade = await disposableDatabase(url!, 'revocation_upgrade');
    try {
      await migrateDatabase(upgrade.pool, '0215_relay_revocation_fence');
      const instanceId = randomUUID();
      const routes = [{ routeId: randomUUID(), endpointId: randomUUID(), routeGeneration: 1, endpointGeneration: 1 }];
      await upgrade.pool.query(`insert into relay_pools (id) values ('system') on conflict do nothing`);
      await upgrade.pool.query(
        `insert into relay_instances (id, pool_id, kind, fault_domain_id, display_name, policy_routes)
         values ($1, 'system', 'remote', $2, 'edge-1', $3)`,
        [instanceId, randomUUID(), JSON.stringify(routes)]
      );
      await migrateDatabase(upgrade.pool);
      const carried = await upgrade.pool.query(
        'select routes from relay_instance_policy_state where instance_id = $1',
        [instanceId]
      );
      expect(carried.rows).toEqual([{ routes }]);
      const column = await upgrade.pool.query(
        `select 1 from information_schema.columns where table_name = 'relay_instances' and column_name = 'policy_routes'`
      );
      expect(column.rowCount).toBe(0);
    } finally {
      await upgrade.drop();
    }
  });
});
