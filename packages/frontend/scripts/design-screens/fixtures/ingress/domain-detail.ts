/**
 * Domain detail dialog, ingress migration and the Add Domain states beyond the
 * Cloudflare preview: the domains of the list (fixtures/edge/domains) with
 * their usage, DNS checks, migrations and DNS conflicts. Seeds 22600-22699.
 */
import { HttpResponse, http } from "msw";
import type {
  CloudflareDomainPreview,
  Domain,
  DomainDnsRecordPreview,
  DomainIngressMigrationImpact,
  DomainWithUsage,
  ExternalDomainPreview,
  ResourceFolderTreeNode,
} from "@/types";
import { wrapped } from "../../handlers";
import { people } from "../catalog";
import { CLOUDFLARE_CONNECTOR_ID, domainNginxNodes, domains } from "../edge/domains";
import { certificates, proxyHosts } from "../routes/data";
import { ago, uuid } from "../time";

const [edgeFraOption, edgeAmsOption] = domainNginxNodes.eligibleNodes;
const nodeOption = (id: string | null | undefined) =>
  domainNginxNodes.eligibleNodes.find((node) => node.id === id) ?? null;

export const domainByName = (name: string) => domains.find((item) => item.domain === name)!;

/** The retired address the legacy admin hostname and a new hostname still resolve to. */
export const RETIRED_ADDRESS = "198.51.100.87";

// ── Detail ──────────────────────────────────────────────────────────────

/**
 * The legacy admin hostname sits in the Cloudflare zone, but its record still
 * points at the retired host, so automatic migration stopped on a conflict.
 */
const DETAIL_OVERRIDES: Record<string, Partial<Domain>> = {
  "legacy-admin.example.com": {
    cloudflareMigrationStatus: "dns_conflict",
    cloudflareMigrationCheckedAt: ago(3, "h"),
  },
};

const labels = (name: string) => name.split(".").length;

function certificateCovers(names: string[], domain: string) {
  return names.some(
    (name) =>
      name === domain ||
      (name.startsWith("*.") && domain.endsWith(name.slice(1)) && labels(name) === labels(domain))
  );
}

export function domainDetail(domain: Domain): DomainWithUsage {
  return {
    ...domain,
    ...DETAIL_OVERRIDES[domain.domain],
    nginxNode: nodeOption(domain.nginxNodeId),
    usage: {
      proxyHosts: proxyHosts
        .filter((host) => host.domainNames.includes(domain.domain))
        .map((host) => ({
          id: host.id,
          slug: host.slug,
          domainNames: host.domainNames,
          enabled: host.enabled,
          nodeId: host.nodeId ?? null,
        })),
      sslCertificates: certificates
        .filter((certificate) => certificateCovers(certificate.domainNames, domain.domain))
        .map((certificate) => ({
          id: certificate.id,
          domainNames: certificate.domainNames,
          status: certificate.status,
          notAfter: certificate.notAfter,
        })),
    },
  };
}

// ── Ingress migration ───────────────────────────────────────────────────

/**
 * docs.example.org is moving from Amsterdam to Frankfurt; its DNS is external,
 * so the move waits until the record points at the Frankfurt edge.
 */
export function startDocsMigration() {
  const docs = domainByName("docs.example.org");
  docs.ingressMigrationId = uuid(22601);
  docs.ingressMigrationSourceNodeId = edgeAmsOption.id;
  docs.ingressMigrationStatus = "waiting_dns";
  docs.nginxNodeId = edgeFraOption.id;
  docs.dnsStatus = "invalid";
  docs.dnsRecords = {
    a: [edgeAmsOption.effectiveAddress],
    aaaa: [],
    cname: [],
    caa: [],
    mx: [],
    txt: [],
  };
}

function migrationImpact(domain: Domain, targetNodeId: string): DomainIngressMigrationImpact {
  const pending = Boolean(domain.ingressMigrationId);
  const source = nodeOption(pending ? domain.ingressMigrationSourceNodeId : domain.nginxNodeId)!;
  const target = nodeOption(targetNodeId)!;
  return {
    status: pending ? "waiting_dns" : "ready",
    sourceNode: source,
    targetNode: target,
    domains: [
      {
        id: domain.id,
        domain: domain.domain,
        dnsProvider: domain.dnsProvider === "cloudflare" ? "cloudflare" : "external",
        dnsStatus: domain.dnsStatus,
      },
    ],
    proxyHosts: domainDetail(domain).usage.proxyHosts,
    targetIps: [target.effectiveAddress],
    requiresExternalDnsBeforeMove: false,
  };
}

// ── New domains ─────────────────────────────────────────────────────────

/** A domain added this morning: no route and no certificate yet. */
export function addBillingDomain() {
  domains.push({
    ...domainByName("api.example.com"),
    id: uuid(22610),
    domain: "billing.example.com",
    description: "Invoices and payment portal",
    lastDnsCheckAt: ago(12, "m"),
    providerRecordIds: ["cf-rec-22610"],
    dnsOwnership: "created",
    sslCertCount: 0,
    proxyHostCount: 0,
    sortOrder: 11,
    createdById: people[2].id,
    createdAt: ago(3, "h"),
    updatedAt: ago(3, "h"),
  });
}

/** Certificate folders an operator with folder-only `ssl:cert:issue` grants may issue into. */
export const sslCertificateFolders: ResourceFolderTreeNode[] = [
  {
    id: uuid(22620),
    name: "Customer domains",
    parentId: null,
    sortOrder: 0,
    depth: 0,
    createdAt: ago(80, "d"),
    updatedAt: ago(80, "d"),
    children: [],
  },
  {
    id: uuid(22621),
    name: "Internal tools",
    parentId: null,
    sortOrder: 1,
    depth: 0,
    createdAt: ago(80, "d"),
    updatedAt: ago(80, "d"),
    children: [],
  },
];

// ── Add Domain previews ─────────────────────────────────────────────────

const record = (content: string, domain: string, id?: string): DomainDnsRecordPreview => ({
  ...(id ? { id } : {}),
  type: "A",
  name: domain,
  content,
  ttl: 300,
  proxied: false,
});

/** An external-DNS hostname that still resolves to the retired host. */
export function externalPreview(domain: string): ExternalDomainPreview {
  return {
    dnsProvider: "external",
    domain,
    nginxNode: edgeFraOption,
    targetIps: [edgeFraOption.effectiveAddress],
    queryName: domain,
    dnsRecords: { a: [RETIRED_ADDRESS], aaaa: [], cname: [], caa: [], mx: [], txt: [] },
    status: "invalid",
  };
}

/** A Cloudflare hostname whose existing record points elsewhere. */
export function conflictPreview(domain: string): CloudflareDomainPreview {
  return {
    dnsProvider: "cloudflare",
    domain,
    zoneName: "example.com",
    connectorId: CLOUDFLARE_CONNECTOR_ID,
    nginxNode: edgeFraOption,
    targetIps: [edgeFraOption.effectiveAddress],
    ttl: 300,
    proxied: false,
    desiredRecords: [record(edgeFraOption.effectiveAddress, domain)],
    currentRecords: [record(RETIRED_ADDRESS, domain, "cf-rec-22630")],
    status: "mismatch",
    canOverwrite: true,
  };
}

export function addDomainPreviewHandlers(kind: "external" | "conflict") {
  return [
    http.post("*/api/domains/preview", async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as { domain?: string };
      const domain = body.domain?.trim() || "portal.example.com";
      return wrapped(kind === "external" ? externalPreview(domain) : conflictPreview(domain));
    }),
    // Adding over a conflicting record asks before overwriting it.
    http.post("*/api/domains", async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as { domain?: string };
      const domain = body.domain?.trim() || "portal.example.com";
      const preview = conflictPreview(domain);
      return HttpResponse.json(
        {
          code: "DOMAIN_DNS_TARGET_MISMATCH",
          message: "Existing Cloudflare DNS record points elsewhere",
          details: {
            domain,
            zoneName: preview.zoneName,
            currentRecords: preview.currentRecords,
            desiredRecords: preview.desiredRecords,
            canOverwrite: true,
          },
        },
        { status: 409 }
      );
    }),
  ];
}

// ── Handlers ────────────────────────────────────────────────────────────

/** Detail reads, DNS checks and migration previews; unknown ids fall through. */
export function domainDetailHandlers() {
  const find = (id: unknown) => domains.find((item) => item.id === id);
  return [
    http.get("*/api/domains/:id", ({ params }) => {
      const domain = find(params.id);
      return domain ? wrapped(domainDetail(domain)) : undefined;
    }),
    // The dialog's check on open: resolved records stay as they were (a retired
    // address stays retired); a hostname never checked resolves to its edge.
    http.post("*/api/domains/:id/check-dns", ({ params }) => {
      const domain = find(params.id);
      if (!domain) return undefined;
      const address = (nodeOption(domain.nginxNodeId) ?? edgeFraOption).effectiveAddress;
      Object.assign(domain, {
        lastDnsCheckAt: new Date().toISOString(),
        ...(domain.dnsRecords
          ? {}
          : {
              dnsStatus: "valid",
              dnsRecords: {
                a: [address],
                aaaa: [],
                cname: [],
                caa: [{ critical: 0, issue: "letsencrypt.org" }],
                mx: [],
                txt: [],
              },
            }),
      });
      return wrapped(domainDetail(domain));
    }),
    http.post("*/api/domains/:id/ingress-migration/preview", async ({ params, request }) => {
      const domain = find(params.id);
      if (!domain) return undefined;
      const body = (await request.json().catch(() => ({}))) as { targetNodeId?: string };
      return wrapped(migrationImpact(domain, body.targetNodeId ?? edgeAmsOption.id));
    }),
    http.get("*/api/ssl-certificates/folders", () => wrapped(sslCertificateFolders)),
  ];
}

/** Holds the dialog's DNS check open, so the section shows it running. */
export function pendingDnsCheckHandlers() {
  return [http.post("*/api/domains/:id/check-dns", () => new Promise<Response>(() => {}))];
}

/** Deleting a domain adopted from existing Cloudflare records asks about those records. */
export function adoptedDomainDeleteHandlers() {
  return [
    http.delete("*/api/domains/:id", async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as { deleteDns?: boolean };
      if (body.deleteDns !== undefined) return new HttpResponse(null, { status: 204 });
      return HttpResponse.json(
        {
          code: "DOMAIN_DNS_DELETE_CHOICE_REQUIRED",
          message: "Choose whether to delete the adopted Cloudflare DNS records",
          details: { recordIds: ["cf-rec-41105", "cf-rec-41105-aaaa"] },
        },
        { status: 409 }
      );
    }),
  ];
}
