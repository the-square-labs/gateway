import { and, inArray, sql } from 'drizzle-orm';
import type { DrizzleTransaction } from '@/db/client.js';
import { hostingFirewalls } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

/** Connector/node lifecycle and firewall writes must have one winner, even between the final fence and HTTP send. */
export async function lockHostingFirewalls(tx: DrizzleTransaction, resourceIds: string[]): Promise<void> {
  const ids = [...new Set(resourceIds)].sort();
  if (!ids.length) return;
  for (const id of ids) {
    const lock = await tx.execute<{ acquired: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${`hosting-firewall:${id}`})) AS acquired`
    );
    if (!lock.rows[0]?.acquired)
      throw new AppError(409, 'HOSTING_FIREWALL_BUSY', 'Firewall is synchronizing; try again shortly');
  }
  const [active] = await tx
    .select({ id: hostingFirewalls.resourceId })
    .from(hostingFirewalls)
    .where(and(inArray(hostingFirewalls.resourceId, ids), inArray(hostingFirewalls.status, ['pending', 'applying'])))
    .limit(1);
  if (active)
    throw new AppError(
      409,
      'HOSTING_FIREWALL_BUSY',
      'Wait for firewall changes to finish before changing this resource'
    );
}
