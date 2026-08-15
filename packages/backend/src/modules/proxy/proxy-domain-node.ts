import { inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { domains } from '@/db/schema/domains.js';
import { AppError } from '@/middleware/error-handler.js';

export function getRegisteredDomainCandidates(domainNames: string[]): string[] {
  return [
    ...new Set(
      domainNames.flatMap((domain) => {
        const normalized = domain.trim().toLowerCase();
        if (!normalized) return [];
        const base = normalized.startsWith('*.') ? normalized.slice(2) : normalized;
        return [base, `*.${base}`];
      })
    ),
  ];
}

export async function assertRegisteredDomainsUseNode(
  db: DrizzleClient,
  domainNames: string[],
  nodeId: string
): Promise<void> {
  const registeredDomainNames = getRegisteredDomainCandidates(domainNames);
  if (registeredDomainNames.length === 0) return;
  const registered = await db
    .select({ domain: domains.domain, nginxNodeId: domains.nginxNodeId })
    .from(domains)
    .where(inArray(sql`lower(${domains.domain})`, registeredDomainNames));
  const mismatch = registered.find((domain) => domain.nginxNodeId !== nodeId);
  if (!mismatch) return;
  throw new AppError(
    409,
    'DOMAIN_NGINX_NODE_MISMATCH',
    mismatch.nginxNodeId
      ? 'The registered domain is assigned to a different Nginx node'
      : 'The registered domain has no resolved Nginx node assignment',
    { domain: mismatch.domain, domainNginxNodeId: mismatch.nginxNodeId, proxyHostNodeId: nodeId }
  );
}
