import type { DnsRecords, DomainCloudflareMigrationStatus, DomainWithUsage } from "@/types";

export function dnsRows(records: DnsRecords) {
  return [
    { type: "A", values: records.a },
    { type: "AAAA", values: records.aaaa },
    { type: "CNAME", values: records.cname },
    {
      type: "CAA",
      values: records.caa.map((record) => {
        const tag = record.issue ? "issue" : "issuewild";
        return `${record.critical} ${tag} ${record.issue ?? record.issuewild ?? ""}`.trim();
      }),
    },
    { type: "MX", values: records.mx.map((record) => `${record.priority} ${record.exchange}`) },
    { type: "TXT", values: records.txt.map((record) => record.join("")) },
  ].filter((row) => row.values.length > 0);
}

export const CLOUDFLARE_MIGRATION_LABELS: Record<DomainCloudflareMigrationStatus, string> = {
  pending: "Checking",
  migrated: "Migrated",
  zone_unavailable: "Zone unavailable",
  zone_ambiguous: "Multiple matching zones",
  ingress_unavailable: "Ingress unavailable",
  dns_conflict: "DNS records conflict",
  ignored: "External DNS retained",
  error: "Migration failed",
};

export type UsageRow =
  | { key: string; type: "Route"; value: DomainWithUsage["usage"]["proxyHosts"][number] }
  | {
      key: string;
      type: "SSL Certificate";
      value: DomainWithUsage["usage"]["sslCertificates"][number];
    };

export type IngressMigrationImpactRow =
  | { key: string; type: "Domain"; target: string }
  | { key: string; type: "Route"; target: string };

export function cloudflareTargetDescription(domain: DomainWithUsage): string | undefined {
  const effectiveAddress = domain.nginxNode?.effectiveAddress;
  if (domain.nginxNode && !effectiveAddress) return "Assigned node has no available public address";
  if (
    effectiveAddress &&
    (domain.dnsTargetIps.length !== 1 || domain.dnsTargetIps[0] !== effectiveAddress)
  ) {
    return `Node public address is ${effectiveAddress}; the tracked origin needs reconciliation`;
  }
  return undefined;
}
