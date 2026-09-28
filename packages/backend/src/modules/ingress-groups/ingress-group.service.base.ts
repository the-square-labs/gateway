import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { domains, ingressGroupMembers, ingressGroups, nodes, proxyHosts } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { DomainsService } from '@/modules/domains/domain.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import type { IngressGroupListQuery } from './ingress-group.schemas.js';
import { INGRESS_GROUP_CAPABILITY, nodeReportsCapability } from './ingress-group-routing.js';
import {
  type IngressGroupView,
  type IngressGroupViewContext,
  ingressGroupDetailView,
  listIngressGroupViews,
} from './ingress-group-views.js';
import { ingressGroupMemberRows } from './ingress-nodes.js';

export interface IngressGroupServiceDeps {
  isNodeConnected(nodeId: string): boolean;
}

/**
 * Ingress groups: sets of nginx nodes (normally one per site) that serve the same routes and domains. Membership
 * changes are planned operations without downtime: a joining member gets every route's config, certificates and
 * secure-link sources before its address is published; a leaving member is withdrawn from DNS first and cleaned up
 * after DNS stopped pointing at it (see IngressGroupConvergence).
 */
export class IngressGroupServiceBase {
  protected proxyService?: ProxyService;
  protected domainsService?: DomainsService;
  protected eventBus?: EventBusService;
  protected registry?: Pick<NodeRegistryService, 'getNode'>;

  constructor(
    protected readonly db: DrizzleClient,
    protected readonly auditService: AuditService,
    protected readonly deps: IngressGroupServiceDeps
  ) {}

  setProxyService(service: ProxyService) {
    this.proxyService = service;
  }
  setDomainsService(service: DomainsService) {
    this.domainsService = service;
  }
  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }
  setNodeRegistry(registry: Pick<NodeRegistryService, 'getNode'>) {
    this.registry = registry;
  }

  protected viewContext(): IngressGroupViewContext {
    return { db: this.db, isNodeConnected: (nodeId) => this.deps.isNodeConnected(nodeId), registry: this.registry };
  }

  protected emit(id: string, action: string) {
    this.eventBus?.publish('ingress_group.changed', { id, action });
  }

  requireProxy(): ProxyService {
    if (!this.proxyService) throw new AppError(503, 'PROXY_SERVICE_UNAVAILABLE', 'Route service is unavailable');
    return this.proxyService;
  }

  requireDomains(): DomainsService {
    if (!this.domainsService) throw new AppError(503, 'DOMAIN_SERVICE_UNAVAILABLE', 'Domain service is unavailable');
    return this.domainsService;
  }

  async list(query: IngressGroupListQuery = {}, options: { groupIds?: string[] | null } = {}) {
    return listIngressGroupViews(this.viewContext(), { ...query, groupIds: options.groupIds });
  }

  /** Every serving member of a group, site preference first. */
  async memberNodeIds(groupId: string): Promise<string[]> {
    return (await ingressGroupMemberRows(this.db, groupId)).map((member) => member.nodeId);
  }

  async requireGroup(id: string) {
    const group = await this.db.query.ingressGroups.findFirst({ where: eq(ingressGroups.id, id) });
    if (!group) throw new AppError(404, 'INGRESS_GROUP_NOT_FOUND', 'Ingress group not found');
    return group;
  }

  async get(id: string) {
    return ingressGroupDetailView(this.viewContext(), await this.requireGroup(id));
  }

  async getSummary(id: string): Promise<IngressGroupView> {
    const [view] = await listIngressGroupViews(this.viewContext(), { groupIds: [id] });
    if (!view) throw new AppError(404, 'INGRESS_GROUP_NOT_FOUND', 'Ingress group not found');
    return view;
  }

  /** Refuses a node that cannot be a member: not nginx, or its daemon does not support ingress groups. */
  protected async requireMemberCandidate(nodeId: string) {
    const [node] = await this.db
      .select({ id: nodes.id, type: nodes.type, hostname: nodes.hostname, capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', `Node ${nodeId} not found`);
    if (node.type !== 'nginx') {
      throw new AppError(400, 'INGRESS_GROUP_MEMBER_NOT_NGINX', `${node.hostname} is not an nginx ingress node`);
    }
    if (!nodeReportsCapability(node.capabilities, INGRESS_GROUP_CAPABILITY)) {
      throw new AppError(
        409,
        'INGRESS_GROUP_MEMBER_UPDATE_REQUIRED',
        `Update the nginx daemon on ${node.hostname}: it does not support ingress groups (${INGRESS_GROUP_CAPABILITY})`,
        { nodeId }
      );
    }
    return node;
  }

  /** Hosts of a group, for membership operations. */
  protected async groupHostIds(groupId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: proxyHosts.id })
      .from(proxyHosts)
      .where(eq(proxyHosts.ingressGroupId, groupId));
    return rows.map((row) => row.id);
  }

  async recordMemberError(groupId: string, nodeId: string, message: string | null) {
    await this.db
      .update(ingressGroupMembers)
      .set({ lastError: message, updatedAt: new Date() })
      .where(and(eq(ingressGroupMembers.groupId, groupId), eq(ingressGroupMembers.nodeId, nodeId)));
  }

  /**
   * The first active member (else the first member) is recorded as `node_id` of the group's routes and
   * `nginx_node_id` of its domains, so code that needs one node keeps a stable answer.
   */
  async syncPrimaryMirrors(groupId: string): Promise<void> {
    const members = await ingressGroupMemberRows(this.db, groupId);
    const primary = members.find((member) => member.state === 'active') ?? members[0];
    if (!primary) return;
    await this.db
      .update(proxyHosts)
      .set({ nodeId: primary.nodeId, updatedAt: new Date() })
      .where(and(eq(proxyHosts.ingressGroupId, groupId), sql`${proxyHosts.nodeId} is distinct from ${primary.nodeId}`));
    await this.db
      .update(domains)
      .set({ nginxNodeId: primary.nodeId, updatedAt: new Date() })
      .where(and(eq(domains.ingressGroupId, groupId), sql`${domains.nginxNodeId} is distinct from ${primary.nodeId}`));
  }

  /** Moves a route onto a group (planned: new members first) or, with null, back to one member node. */
  async convertRoute(
    proxyHostId: string,
    target: { ingressGroupId: string | null; nodeId?: string | null },
    userId: string
  ) {
    const proxy = this.requireProxy();
    await proxy.changeRoutePlacement(
      proxyHostId,
      { ingressGroupId: target.ingressGroupId, nodeId: target.nodeId ?? null },
      userId
    );
    return proxy.getProxyHost(proxyHostId);
  }

  /** Moves a domain and its routes onto a group or back to one member node (see changeDomainIngressPlacement). */
  async convertDomain(
    domainId: string,
    target: { ingressGroupId: string | null; nginxNodeId?: string },
    userId: string
  ) {
    return this.requireDomains().changeDomainIngressPlacement(domainId, target, userId);
  }
}
