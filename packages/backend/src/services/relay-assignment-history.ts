import { sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { relayEndpointAssignmentGenerations } from '@/db/schema/index.js';

/** Ended placements (retired, failed, deferred) are kept this long for the pool's history. */
const ENDED_GENERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** The newest placements of every endpoint are always kept, whatever their age. */
const KEPT_GENERATIONS_PER_ENDPOINT = 20;

/**
 * Deletes old ended placements with their assignments and source probes (on delete cascade). Nothing else removed
 * them while the endpoint lived, and every rebalance, probe and drain adds rows. Live generations (active, staging,
 * draining) are never touched, nor the newest ones of an endpoint: the next generation number continues from the
 * highest, which therefore always stays. Returns the number deleted.
 */
export async function pruneEndedAssignmentGenerations(db: DrizzleClient, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - ENDED_GENERATION_RETENTION_MS);
  const generations = relayEndpointAssignmentGenerations;
  const deleted = await db.execute(sql`
    delete from ${generations}
    where ${generations.id} in (
      select ranked.id from (
        select ${generations.id} as id, ${generations.state} as state, ${generations.updatedAt} as updated_at,
          row_number() over (partition by ${generations.endpointId} order by ${generations.generation} desc) as rank
        from ${generations}
      ) ranked
      where ranked.rank > ${KEPT_GENERATIONS_PER_ENDPOINT}
        and ranked.state in ('retired', 'failed')
        and ranked.updated_at < ${cutoff}
    )
  `);
  return Number((deleted as { rowCount?: number | null }).rowCount ?? 0);
}
