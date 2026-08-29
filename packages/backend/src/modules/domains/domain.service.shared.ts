import type { DnsRecords } from '@/db/schema/domains.js';
import { createChildLogger } from '@/lib/logger.js';
import type { CloudflareClient, CloudflareDnsRecordInput } from '@/modules/integrations/cloudflare-client.js';
export const logger = createChildLogger('DomainsService');

export interface DomainUsage {
  proxyHosts: Array<{ id: string; slug: string; domainNames: string[]; enabled: boolean; nodeId: string | null }>;
  sslCertificates: Array<{ id: string; domainNames: string[]; status: string; notAfter: Date | null }>;
}

export interface EligibleNginxNode {
  id: string;
  slug: string;
  hostname: string;
  displayName: string | null;
  appearanceColor: string | null;
  effectiveAddress: string;
  effectiveAddresses?: string[];
}

export interface NginxNodeOptions {
  eligibleNodes: EligibleNginxNode[];
  unconfiguredNodes: Array<{
    id: string;
    slug: string;
    hostname: string;
    displayName: string | null;
    appearanceColor: string | null;
  }>;
  totalNginxNodes: number;
  unconfiguredNginxNodes: number;
}

export function selectBackfillNginxNode(
  eligibleNodes: EligibleNginxNode[],
  usedNodeIds: Array<string | null>
): EligibleNginxNode | undefined {
  if (usedNodeIds.some((nodeId) => !nodeId)) return undefined;
  const distinctUsedNodeIds = [...new Set(usedNodeIds)];
  if (distinctUsedNodeIds.length === 0) return eligibleNodes[0];
  if (distinctUsedNodeIds.length !== 1) return undefined;
  return eligibleNodes.find((node) => node.id === distinctUsedNodeIds[0]);
}

export type CloudflareAddressRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean | null;
};

export type DomainCloudflarePlan = {
  domainName: string;
  nginxNode: EligibleNginxNode;
  targetIps: string[];
  ttl: number;
  proxied: boolean;
  context: {
    connector: { id: string };
    zone: { remoteId: string; name: string };
    settings: { defaultTtl: number; defaultProxied: boolean };
    client: CloudflareClient;
  };
  addressRecords: CloudflareAddressRecord[];
  blockingRecords: CloudflareAddressRecord[];
  currentIps: string[];
  desiredIps: string[];
  currentMatches: boolean;
  desiredRecords: CloudflareDnsRecordInput[];
};

export type DomainExternalPlan = {
  domainName: string;
  nginxNode: EligibleNginxNode;
  targetIps: string[];
  queryName: string;
  dnsRecords: DnsRecords;
  status: 'valid' | 'invalid' | 'pending' | 'unknown';
};
