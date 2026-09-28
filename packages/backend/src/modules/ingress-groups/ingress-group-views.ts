import { and, asc, count, eq, ilike, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  domains,
  ingressGroupMembers,
  ingressGroups,
  ingressMemberDeliveries,
  nginxCertificateAssets,
  nodes,
  proxyHosts,
} from '@/db/schema/index.js';
import { escapeLike } from '@/lib/utils.js';
import { getEffectiveNginxIngressAddresses } from '@/modules/nodes/node-service-address.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import { INGRESS_GROUP_CAPABILITY, nodeReportsCapability } from './ingress-group-routing.js';
import { ingressHealthOf } from './ingress-health.js';
import { orderIngressMembers } from './ingress-nodes.js';

export const INGRESS_GROUP_DNS_NONE_NOTE =
  'DNS failover: none. The Cloudflare records of the group’s domains list every active member (round robin); Cloudflare does not health-check plain records, so clients keep reaching a member that is down until it is removed from the group or a DNS failover mode is chosen.';

type GroupRow = typeof ingressGroups.$inferSelect;

export interface IngressGroupMemberView {
  nodeId: string;
  priority: number;
  state: 'joining' | 'active' | 'draining';
  drainStartedAt: string | null;
  lastError: string | null;
  node: {
    id: string;
    slug: string;
    hostname: string;
    displayName: string | null;
    status: string;
    connected: boolean;
    capable: boolean;
    addresses: string[];
  } | null;
  health: ReturnType<typeof ingressHealthOf>;
  delivery: { ready: number; pending: number; failed: number };
}

export interface IngressGroupView {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  folderId: string | null;
  dnsFailoverMode: string;
  dnsFailoverNote: string;
  createdAt: Date;
  updatedAt: Date;
  members: IngressGroupMemberView[];
  routeCount: number;
  domainCount: number;
  /** Every member active, connected, serving and with every route delivered. */
  healthy: boolean;
}

export interface IngressGroupViewContext {
  db: DrizzleClient;
  isNodeConnected(nodeId: string): boolean;
  registry?: Pick<NodeRegistryService, 'getNode'>;
}

async function memberViews(context: IngressGroupViewContext, groupIds: string[]) {
  if (groupIds.length === 0) return new Map<string, IngressGroupMemberView[]>();
  const members = await context.db
    .select()
    .from(ingressGroupMembers)
    .where(inArray(ingressGroupMembers.groupId, groupIds));
  const nodeIds = [...new Set(members.map((member) => member.nodeId))];
  const [nodeRows, deliveries] = await Promise.all([
    nodeIds.length
      ? context.db
          .select({
            id: nodes.id,
            slug: nodes.slug,
            hostname: nodes.hostname,
            displayName: nodes.displayName,
            status: nodes.status,
            capabilities: nodes.capabilities,
            serviceAddresses: nodes.serviceAddresses,
            serviceAddress: nodes.serviceAddress,
            secondaryServiceAddress: nodes.secondaryServiceAddress,
            lastHealthReport: nodes.lastHealthReport,
          })
          .from(nodes)
          .where(inArray(nodes.id, nodeIds))
      : [],
    context.db
      .select({
        nodeId: ingressMemberDeliveries.nodeId,
        groupId: proxyHosts.ingressGroupId,
        status: ingressMemberDeliveries.status,
      })
      .from(ingressMemberDeliveries)
      .innerJoin(proxyHosts, eq(proxyHosts.id, ingressMemberDeliveries.hostId))
      .where(inArray(proxyHosts.ingressGroupId, groupIds)),
  ]);
  const result = new Map<string, IngressGroupMemberView[]>();
  for (const groupId of groupIds) {
    const ordered = orderIngressMembers(members.filter((member) => member.groupId === groupId));
    result.set(
      groupId,
      ordered.map((member) => {
        const node = nodeRows.find((row) => row.id === member.nodeId);
        const report = context.registry?.getNode(member.nodeId)?.lastHealthReport ?? node?.lastHealthReport ?? null;
        const memberDeliveries = deliveries.filter(
          (delivery) => delivery.groupId === groupId && delivery.nodeId === member.nodeId
        );
        return {
          nodeId: member.nodeId,
          priority: member.priority,
          state: member.state,
          drainStartedAt: member.drainStartedAt?.toISOString() ?? null,
          lastError: member.lastError,
          node: node
            ? {
                id: node.id,
                slug: node.slug,
                hostname: node.hostname,
                displayName: node.displayName,
                status: node.status,
                connected: context.isNodeConnected(node.id),
                capable: nodeReportsCapability(node.capabilities, INGRESS_GROUP_CAPABILITY),
                addresses: getEffectiveNginxIngressAddresses({
                  serviceAddresses: node.serviceAddresses,
                  serviceAddress: node.serviceAddress,
                  secondaryServiceAddress: node.secondaryServiceAddress,
                  lastHealthReport: report,
                }),
              }
            : null,
          health: ingressHealthOf(report),
          delivery: {
            ready: memberDeliveries.filter((delivery) => delivery.status === 'ready').length,
            pending: memberDeliveries.filter((delivery) => delivery.status === 'pending').length,
            failed: memberDeliveries.filter((delivery) => delivery.status === 'failed').length,
          },
        };
      })
    );
  }
  return result;
}

async function usageCounts(db: DrizzleClient, groupIds: string[]) {
  if (groupIds.length === 0) return { routes: new Map<string, number>(), domains: new Map<string, number>() };
  const [routeRows, domainRows] = await Promise.all([
    db
      .select({ groupId: proxyHosts.ingressGroupId, total: count() })
      .from(proxyHosts)
      .where(inArray(proxyHosts.ingressGroupId, groupIds))
      .groupBy(proxyHosts.ingressGroupId),
    db
      .select({ groupId: domains.ingressGroupId, total: count() })
      .from(domains)
      .where(inArray(domains.ingressGroupId, groupIds))
      .groupBy(domains.ingressGroupId),
  ]);
  return {
    routes: new Map(routeRows.map((row) => [row.groupId!, Number(row.total)])),
    domains: new Map(domainRows.map((row) => [row.groupId!, Number(row.total)])),
  };
}

function toView(
  group: GroupRow,
  members: IngressGroupMemberView[],
  routeCount: number,
  domainCount: number
): IngressGroupView {
  return {
    id: group.id,
    name: group.name,
    slug: group.slug,
    description: group.description,
    folderId: group.folderId,
    dnsFailoverMode: group.dnsFailoverMode,
    dnsFailoverNote: INGRESS_GROUP_DNS_NONE_NOTE,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    members,
    routeCount,
    domainCount,
    healthy:
      members.length > 0 &&
      members.every(
        (member) =>
          member.state === 'active' &&
          member.node?.connected === true &&
          member.health?.serving !== false &&
          member.delivery.pending === 0 &&
          member.delivery.failed === 0
      ),
  };
}

export async function listIngressGroupViews(
  context: IngressGroupViewContext,
  filter: { search?: string; folderId?: string; groupIds?: string[] | null } = {}
): Promise<IngressGroupView[]> {
  if (filter.groupIds && filter.groupIds.length === 0) return [];
  const rows = await context.db
    .select()
    .from(ingressGroups)
    .where(
      and(
        filter.search ? ilike(ingressGroups.name, `%${escapeLike(filter.search)}%`) : undefined,
        filter.folderId ? eq(ingressGroups.folderId, filter.folderId) : undefined,
        filter.groupIds ? inArray(ingressGroups.id, filter.groupIds) : undefined
      )
    )
    .orderBy(asc(ingressGroups.name), asc(ingressGroups.id));
  const ids = rows.map((row) => row.id);
  const [members, counts] = await Promise.all([memberViews(context, ids), usageCounts(context.db, ids)]);
  return rows.map((row) =>
    toView(row, members.get(row.id) ?? [], counts.routes.get(row.id) ?? 0, counts.domains.get(row.id) ?? 0)
  );
}

/** A group with its routes (per-member delivery and certificate versions) and domains (DNS). */
export async function ingressGroupDetailView(context: IngressGroupViewContext, group: GroupRow) {
  const [base] = await listIngressGroupViews(context, { groupIds: [group.id] });
  const [routes, groupDomains] = await Promise.all([
    context.db
      .select({
        id: proxyHosts.id,
        slug: proxyHosts.slug,
        domainNames: proxyHosts.domainNames,
        enabled: proxyHosts.enabled,
        healthStatus: proxyHosts.healthStatus,
        sslEnabled: proxyHosts.sslEnabled,
        sslCertificateId: proxyHosts.sslCertificateId,
        internalCertificateId: proxyHosts.internalCertificateId,
        isSystem: proxyHosts.isSystem,
      })
      .from(proxyHosts)
      .where(eq(proxyHosts.ingressGroupId, group.id))
      .orderBy(asc(proxyHosts.createdAt)),
    context.db
      .select({
        id: domains.id,
        domain: domains.domain,
        dnsProvider: domains.dnsProvider,
        dnsStatus: domains.dnsStatus,
        dnsTargetIps: domains.dnsTargetIps,
        dnsProxied: domains.dnsProxied,
        dnsTtl: domains.dnsTtl,
      })
      .from(domains)
      .where(eq(domains.ingressGroupId, group.id))
      .orderBy(asc(domains.domain)),
  ]);
  const hostIds = routes.map((route) => route.id);
  const deliveries = hostIds.length
    ? await context.db.select().from(ingressMemberDeliveries).where(inArray(ingressMemberDeliveries.hostId, hostIds))
    : [];
  const references = routes.flatMap((route) =>
    route.sslEnabled && (route.sslCertificateId || route.internalCertificateId)
      ? [route.sslCertificateId ?? route.internalCertificateId!]
      : []
  );
  const assets = references.length
    ? await context.db
        .select({
          referenceId: nginxCertificateAssets.referenceId,
          referenceType: nginxCertificateAssets.referenceType,
          version: nginxCertificateAssets.version,
        })
        .from(nginxCertificateAssets)
        .where(inArray(nginxCertificateAssets.referenceId, references))
    : [];
  return {
    ...base!,
    routes: routes.map((route) => {
      const reference = route.sslCertificateId
        ? { type: 'ssl', id: route.sslCertificateId }
        : route.internalCertificateId
          ? { type: 'internal', id: route.internalCertificateId }
          : null;
      const currentCertificateVersion =
        route.sslEnabled && reference
          ? (assets.find((asset) => asset.referenceType === reference.type && asset.referenceId === reference.id)
              ?.version ?? null)
          : null;
      return {
        id: route.id,
        slug: route.slug,
        domainNames: route.domainNames,
        enabled: route.enabled,
        healthStatus: route.healthStatus,
        isSystem: route.isSystem,
        currentCertificateVersion,
        members: (base?.members ?? []).map((member) => {
          const delivery = deliveries.find(
            (candidate) => candidate.hostId === route.id && candidate.nodeId === member.nodeId
          );
          return {
            nodeId: member.nodeId,
            status: !route.enabled ? 'disabled' : (delivery?.status ?? 'pending'),
            desiredConfigHash: delivery?.desiredConfigHash ?? null,
            appliedConfigHash: delivery?.appliedConfigHash ?? null,
            appliedCertificateVersion: delivery?.appliedCertificateVersion ?? null,
            certificateCurrent:
              !currentCertificateVersion || delivery?.appliedCertificateVersion === currentCertificateVersion,
            lastError: delivery?.lastError ?? null,
            appliedAt: delivery?.appliedAt?.toISOString() ?? null,
          };
        }),
      };
    }),
    domains: groupDomains,
  };
}
