// ── Domains ───────────────────────────────────────────────────────

export type DnsStatus = "valid" | "invalid" | "pending" | "unknown";
export type DomainDnsProvider = "legacy" | "cloudflare";
export type DomainDnsOwnership = "legacy" | "created" | "matched_existing" | "overwritten";

export interface DnsRecords {
  a: string[];
  aaaa: string[];
  cname: string[];
  caa: Array<{ critical: number; issue?: string; issuewild?: string }>;
  mx: Array<{ exchange: string; priority: number }>;
  txt: string[][];
}

export interface Domain {
  id: string;
  domain: string;
  description: string | null;
  dnsStatus: DnsStatus;
  lastDnsCheckAt: string | null;
  dnsRecords: DnsRecords | null;
  dnsProvider: DomainDnsProvider;
  dnsOwnership: DomainDnsOwnership;
  integrationConnectorId: string | null;
  providerZoneId: string | null;
  providerZoneName: string | null;
  providerRecordIds: string[];
  dnsRecordType: string | null;
  dnsTargetIps: string[];
  dnsTtl: number | null;
  dnsProxied: boolean | null;
  nginxNodeId: string | null;
  isSystem?: boolean;
  folderId?: string | null;
  sortOrder?: number;
  sslCertCount?: number;
  proxyHostCount?: number;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface DomainUsage {
  proxyHosts: Array<{
    id: string;
    slug: string;
    domainNames: string[];
    enabled: boolean;
    nodeId: string | null;
  }>;
  sslCertificates: Array<{
    id: string;
    domainNames: string[];
    status: string;
    notAfter: string | null;
  }>;
}

export interface DomainWithUsage extends Domain {
  nginxNode: DomainNginxNode | null;
  usage: DomainUsage;
}

export interface DomainNginxNode {
  id: string;
  slug: string;
  hostname: string;
  displayName: string | null;
  appearanceColor: string | null;
  effectiveAddress?: string;
}

export interface DomainNginxNodeOptions {
  eligibleNodes: Array<DomainNginxNode & { effectiveAddress: string }>;
  unconfiguredNodes: DomainNginxNode[];
  totalNginxNodes: number;
  unconfiguredNginxNodes: number;
}

export interface DomainSearchResult {
  id: string;
  domain: string;
  dnsStatus: DnsStatus;
}

export interface CreateDomainRequest {
  domain: string;
  description?: string;
  folderId?: string | null;
  ttl?: number;
  proxied?: boolean;
  overwriteDns?: boolean;
  nginxNodeId?: string;
}

export interface DeleteDomainRequest {
  deleteDns?: boolean;
}

export interface DomainDnsRecordPreview {
  id?: string;
  type: string;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean | null;
}

export interface DomainDnsConflictDetails {
  domain?: string;
  zoneName?: string;
  currentRecords?: DomainDnsRecordPreview[];
  desiredRecords?: DomainDnsRecordPreview[];
  canOverwrite?: boolean;
  recordIds?: string[];
}

export interface DomainPreview {
  domain: string;
  zoneName: string;
  connectorId: string;
  nginxNode: DomainNginxNode & { effectiveAddress: string };
  targetIps: string[];
  ttl: number;
  proxied: boolean;
  desiredRecords: DomainDnsRecordPreview[];
  currentRecords: DomainDnsRecordPreview[];
  status: "ready" | "matched" | "mismatch" | "blocked";
  canOverwrite: boolean;
}

export interface UpdateDomainRequest {
  description?: string | null;
  proxied?: boolean;
}
