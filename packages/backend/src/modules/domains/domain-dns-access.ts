import { eq } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { domains } from '@/db/schema/domains.js';
import { hasScope, hasScopeBase } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';

function dnsUpdateDenied(details: Record<string, unknown>) {
  return new AppError(
    403,
    'FORBIDDEN',
    'Updating assigned domain DNS targets requires domain edit access on every domain assigned to this node',
    details
  );
}

/**
 * Confirming an ingress node address change rewrites the tracked DNS target of every
 * domain assigned to that node, so the caller needs domains:edit on each of them:
 * broadly, per domain, or through the domain's folder (expanded to per-domain grants).
 */
export async function assertNodeDomainDnsUpdateAccess(
  nodeId: string,
  scopes: string[],
  db?: DrizzleClient
): Promise<void> {
  if (hasScope(scopes, 'domains:edit')) return;
  // Without any domain edit grant the assigned domains are not even looked up.
  if (!hasScopeBase(scopes, 'domains:edit')) throw dnsUpdateDenied({ requiredScope: 'domains:edit' });
  const client = db ?? container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
  const assigned = await client.select({ id: domains.id }).from(domains).where(eq(domains.nginxNodeId, nodeId));
  const denied = assigned.filter((domain) => !hasScope(scopes, `domains:edit:${domain.id}`));
  if (denied.length > 0) {
    throw dnsUpdateDenied({ requiredScope: `domains:edit:${denied[0]!.id}`, deniedDomainCount: denied.length });
  }
}
