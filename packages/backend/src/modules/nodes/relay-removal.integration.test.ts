import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema/index.js';
import { NodesService } from './nodes.service.js';

// Opt-in, disposable local PostgreSQL only. Apply repository migrations first.
const databaseUrl = process.env.RELAY_REMOVAL_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('relay removal with PostgreSQL foreign keys and locks', () => {
  it('removes an expired offline member with 12 covered assignments and completed update history', async () => {
    const url = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Local disposable test database required');
    const client = new pg.Pool({ connectionString: databaseUrl });
    const db = drizzle(client, { schema });
    const rollback = new Error('rollback test fixture');
    try {
      await expect(
        db.transaction(async (tx) => {
          const nodeId = randomUUID();
          const deadId = randomUUID();
          const liveId = randomUUID();
          await tx.insert(schema.relayPools).values({ id: 'system' }).onConflictDoNothing();
          await tx
            .insert(schema.nodes)
            .values({ id: nodeId, type: 'relay', hostname: 'test-dead', slug: nodeId, status: 'offline' });
          await tx.insert(schema.relayInstances).values([
            {
              id: deadId,
              poolId: 'system',
              kind: 'remote',
              nodeId,
              faultDomainId: randomUUID(),
              displayName: 'test-dead',
              state: 'offline',
              lastSeenAt: new Date(1),
              policyExpiresAt: new Date(2),
              health: { activeTunnels: 99 },
            },
            {
              id: liveId,
              poolId: 'system',
              kind: 'local',
              faultDomainId: randomUUID(),
              displayName: 'test-live',
              state: 'ready',
              lastSeenAt: new Date(),
              policyExpiresAt: new Date(Date.now() + 60_000),
            },
          ]);
          for (let i = 0; i < 12; i++) {
            const endpointId = randomUUID();
            const generationId = randomUUID();
            await tx.insert(schema.relayEndpoints).values({
              id: endpointId,
              ownerKind: 'test',
              ownerId: endpointId,
              subjectKind: 'daemon',
              subjectId: nodeId,
              certificateSha256: `sha256:${'a'.repeat(64)}`,
            });
            await tx
              .insert(schema.relayEndpointAssignmentGenerations)
              .values({ id: generationId, endpointId, generation: 1, state: 'active', desiredRedundancy: 2 });
            await tx.insert(schema.relayEndpointAssignments).values(
              [deadId, liveId].map((relayInstanceId) => ({
                relayInstanceId,
                assignmentGenerationId: generationId,
                role: 'active' as const,
                targetRegistrationState: 'ready' as const,
              }))
            );
          }
          const [run] = await tx
            .insert(schema.relayPoolUpdateRuns)
            .values({
              poolId: 'system',
              state: 'complete',
              targetArtifact: { version: 'test', digest: 'test', architecture: 'amd64' },
            })
            .returning();
          await tx.insert(schema.relayPoolUpdateSteps).values({
            runId: run.id,
            relayInstanceId: deadId,
            sequence: 0,
            state: 'ready',
            targetArtifact: { version: 'test', digest: 'test', architecture: 'amd64' },
          });
          const retireOwner = vi.fn(async () => undefined);
          const service = new NodesService(
            tx as never,
            { log: vi.fn() } as never,
            { getNode: vi.fn() } as never,
            {} as never,
            {} as never
          );
          service.setSystemCertificateLifecycleService({ retireOwner, retryPendingCRLs: vi.fn() } as never);
          await service.remove(nodeId, 'test-user');
          expect(await tx.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId))).toHaveLength(0);
          expect(
            await tx.select().from(schema.relayInstances).where(eq(schema.relayInstances.id, deadId))
          ).toHaveLength(0);
          expect(
            await tx
              .select()
              .from(schema.relayEndpointAssignments)
              .where(eq(schema.relayEndpointAssignments.relayInstanceId, liveId))
          ).toHaveLength(12);
          expect(
            await tx.select().from(schema.relayPoolUpdateRuns).where(eq(schema.relayPoolUpdateRuns.id, run.id))
          ).toHaveLength(1);
          expect(retireOwner).toHaveBeenCalledTimes(2);
          throw rollback;
        })
      ).rejects.toBe(rollback);
    } finally {
      await client.end();
    }
  });
});
