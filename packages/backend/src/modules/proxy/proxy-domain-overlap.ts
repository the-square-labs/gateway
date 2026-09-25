import { and, eq, ne, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { proxyHosts } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

/**
 * Two enabled proxy hosts on one node must not serve the same name: nginx keeps
 * one server block and ignores the other ("conflicting server name"), so edits
 * and deletes then act on a host that is not serving. Callers hold the node's
 * proxy lock (`proxyNodeLockKey`) across this check and the write that makes
 * the host serve, so two concurrent creates cannot both pass it.
 */
export async function assertNoProxyDomainOverlap(
  db: DrizzleClient,
  nodeId: string,
  domainNames: string[],
  excludeHostId?: string
): Promise<void> {
  const requested = [...new Set(domainNames.map((domain) => domain.trim().toLowerCase()).filter(Boolean))];
  if (requested.length === 0) return;
  const [conflict] = await db
    .select({ id: proxyHosts.id, domainNames: proxyHosts.domainNames })
    .from(proxyHosts)
    .where(
      and(
        eq(proxyHosts.nodeId, nodeId),
        eq(proxyHosts.enabled, true),
        excludeHostId ? ne(proxyHosts.id, excludeHostId) : undefined,
        sql`exists (select 1 from jsonb_array_elements_text(${proxyHosts.domainNames}) as served(name) where lower(served.name) in (${sql.join(
          requested.map((domain) => sql`${domain}`),
          sql`, `
        )}))`
      )
    )
    .limit(1);
  if (!conflict) return;
  const overlapping = (conflict.domainNames ?? []).filter((domain) => requested.includes(domain.toLowerCase()));
  throw new AppError(
    409,
    'PROXY_HOST_DOMAIN_CONFLICT',
    `Another enabled proxy host on this node already serves ${overlapping.join(', ') || 'these domains'}`,
    { proxyHostId: conflict.id, nodeId, domains: overlapping }
  );
}
