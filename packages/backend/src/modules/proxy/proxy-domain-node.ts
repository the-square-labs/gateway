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
        const labels = base.split('.');
        return [base, ...labels.slice(0, -1).map((_, index) => `*.${labels.slice(index).join('.')}`)];
      })
    ),
  ];
}

export interface RegisteredDomainNode {
  domain: string;
  nginxNodeId: string | null;
}

/** Registered Gateway domains (exact or covering wildcard) that apply to these route domain names. */
export async function findRegisteredDomainNodes(
  db: DrizzleClient,
  domainNames: string[]
): Promise<RegisteredDomainNode[]> {
  const registeredDomainNames = getRegisteredDomainCandidates(domainNames);
  if (registeredDomainNames.length === 0) return [];
  return db
    .select({ domain: domains.domain, nginxNodeId: domains.nginxNodeId })
    .from(domains)
    .where(inArray(sql`lower(${domains.domain})`, registeredDomainNames));
}

export async function assertRegisteredDomainsUseNode(
  db: DrizzleClient,
  domainNames: string[],
  nodeId: string
): Promise<void> {
  const registered = await findRegisteredDomainNodes(db, domainNames);
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

/**
 * The ingress node the registered domains of a new route pin, or null when none of its names is a
 * registered Gateway domain. Every registered domain must name the same resolved node, as
 * {@link assertRegisteredDomainsUseNode} requires for an explicit node.
 */
export function registeredDomainsIngressNodeId(registered: readonly RegisteredDomainNode[]): string | null {
  if (registered.length === 0) return null;
  const unresolved = registered.find((domain) => !domain.nginxNodeId);
  if (unresolved) {
    throw new AppError(
      409,
      'DOMAIN_NGINX_NODE_MISMATCH',
      `The registered domain ${unresolved.domain} has no resolved Nginx node assignment`,
      { domain: unresolved.domain, domainNginxNodeId: null, proxyHostNodeId: null }
    );
  }
  const nodeIds = [...new Set(registered.map((domain) => domain.nginxNodeId as string))];
  if (nodeIds.length > 1) {
    throw new AppError(
      409,
      'DOMAIN_NGINX_NODE_MISMATCH',
      `The registered domains of this route are assigned to different Nginx nodes (${registered
        .map((domain) => `${domain.domain} on ${domain.nginxNodeId}`)
        .join(', ')}); one route serves domains of one ingress node`,
      { domains: registered.map(({ domain, nginxNodeId }) => ({ domain, nginxNodeId })), proxyHostNodeId: null }
    );
  }
  return nodeIds[0]!;
}
