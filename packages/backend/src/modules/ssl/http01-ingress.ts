import { sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { domains, nodes, proxyHosts } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { getEffectiveNginxIngressAddress } from '@/modules/nodes/node-service-address.js';

export type Http01IngressResolution = {
  domain: string;
  nodeId: string;
  source: 'domain' | 'proxy_host';
};

function normalizeHttp01Domain(domain: string): string {
  const normalized = domain.trim().toLowerCase();
  if (normalized.startsWith('*.')) {
    throw new AppError(400, 'HTTP01_WILDCARD_UNSUPPORTED', 'HTTP-01 cannot validate wildcard domains');
  }
  return normalized;
}

/**
 * Resolve the one Nginx ingress that will receive an HTTP-01 validation request.
 * Registered Domain affinity is authoritative. Existing Proxy Hosts are only a
 * compatibility source for certificates created before Domain registration was
 * required; there is intentionally no default-node or all-node fallback.
 */
export async function resolveHttp01Ingress(
  db: DrizzleClient,
  requestedDomain: string
): Promise<Http01IngressResolution> {
  const domain = normalizeHttp01Domain(requestedDomain);
  const registered = await db.query.domains.findFirst({
    where: sql`lower(${domains.domain}) = ${domain}`,
    columns: { domain: true, nginxNodeId: true },
  });

  let nodeId = registered?.nginxNodeId ?? null;
  let source: Http01IngressResolution['source'] = 'domain';

  if (registered && !nodeId) {
    throw new AppError(409, 'HTTP01_INGRESS_UNASSIGNED', 'The registered domain has no Nginx ingress assignment', {
      domain,
    });
  }

  if (!registered) {
    const legacyHosts = await db.query.proxyHosts.findMany({
      where: sql`EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(${proxyHosts.domainNames}) AS proxy_domain(value)
        WHERE lower(proxy_domain.value) = ${domain}
      )`,
      columns: { nodeId: true },
    });
    const legacyNodeIds = [...new Set(legacyHosts.map((host) => host.nodeId).filter((id): id is string => !!id))];
    if (legacyNodeIds.length === 0) {
      throw new AppError(
        409,
        'HTTP01_DOMAIN_NOT_REGISTERED',
        'Register the domain and assign its Nginx ingress before using HTTP-01',
        { domain }
      );
    }
    if (legacyNodeIds.length > 1) {
      throw new AppError(
        409,
        'HTTP01_INGRESS_AMBIGUOUS',
        'Existing Proxy Hosts for this domain use different Nginx nodes; register the domain before using HTTP-01',
        { domain, nodeIds: legacyNodeIds }
      );
    }
    nodeId = legacyNodeIds[0]!;
    source = 'proxy_host';
  }

  if (!nodeId) {
    throw new AppError(409, 'HTTP01_INGRESS_UNASSIGNED', 'The domain has no Nginx ingress assignment', { domain });
  }

  const node = await db.query.nodes.findFirst({
    where: sql`${nodes.id} = ${nodeId}`,
    columns: { id: true, type: true, status: true, serviceAddresses: true, lastHealthReport: true },
  });
  if (!node || node.type !== 'nginx' || node.status !== 'online') {
    throw new AppError(409, 'HTTP01_INGRESS_UNAVAILABLE', 'The Nginx ingress assigned to this domain is not online', {
      domain,
      nodeId,
    });
  }
  if (!getEffectiveNginxIngressAddress(node)) {
    throw new AppError(
      409,
      'HTTP01_INGRESS_ADDRESS_REQUIRED',
      'The assigned Nginx ingress has no detected public service address',
      { domain, nodeId }
    );
  }

  return { domain, nodeId, source };
}
