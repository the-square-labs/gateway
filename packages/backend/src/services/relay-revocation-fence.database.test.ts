import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { relayEndpoints, relayInstances, relayPolicyState, relayPools, relayRoutes } from '@/db/schema/index.js';
import { RELAY_REVOCATION_ACK_TIMEOUT_MS } from './relay-revocation-fence.js';
import {
  loadRevocationFenceState,
  RELAY_POLICY_REVISION_LOCK,
  RelayRevocationFenceService,
  recordBuiltPolicyRoutes,
} from './relay-revocation-fence.service.js';

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;
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

  afterAll(async () => {
    await database?.drop();
  });

  it('fences a relay that missed a revocation and clears it once the relay applies the revoking revision', async () => {
    const tuple = (routeId: string) => ({ routeId, endpointId, routeGeneration: 1, endpointGeneration: 1 });
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${RELAY_POLICY_REVISION_LOCK}))`);
      const [instance] = await tx.select().from(relayInstances).where(eq(relayInstances.id, relayId));
      await recordBuiltPolicyRoutes(tx, instance!, [tuple(keptRouteId), tuple(revokedRouteId)], 10);
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
    const [instance] = await db.select().from(relayInstances).where(eq(relayInstances.id, relayId));
    expect(instance?.policyRoutes).toEqual([tuple(keptRouteId)]);
  });
});
