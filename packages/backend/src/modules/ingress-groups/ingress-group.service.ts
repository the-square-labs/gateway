import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { domains, ingressGroupMembers, ingressGroups, nodes, proxyHosts } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { DomainsService } from '@/modules/domains/domain.service.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import { rethrowProxyHostDomainConflict } from '@/modules/proxy/proxy-domain-overlap.js';
import { ingressGroupLockKey, proxyNodeLockKey, withProxyLocks } from '@/modules/proxy/proxy-host-lock.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import type {
  AddIngressGroupMemberInput,
  CreateIngressGroupInput,
  IngressGroupListQuery,
  RemoveIngressGroupMemberInput,
  UpdateIngressGroupInput,
} from './ingress-group.schemas.js';
import { INGRESS_GROUP_CAPABILITY, nodeReportsCapability } from './ingress-group-routing.js';
import {
  type IngressGroupView,
  type IngressGroupViewContext,
  ingressGroupDetailView,
  listIngressGroupViews,
} from './ingress-group-views.js';
import { ingressGroupMemberRows } from './ingress-nodes.js';

const logger = createChildLogger('IngressGroupService');
const GROUP_SLUG_CONSTRAINT = 'ingress_groups_slug_unique';

export interface IngressGroupServiceDeps {
  isNodeConnected(nodeId: string): boolean;
}

/**
 * Ingress groups: sets of nginx nodes (normally one per site) that serve the same routes and domains. Membership
 * changes are planned operations without downtime: a joining member gets every route's config, certificates and
 * secure-link sources before its address is published; a leaving member is withdrawn from DNS first and cleaned up
 * after DNS stopped pointing at it (see IngressGroupConvergence).
 */
export class IngressGroupService {
  private proxyService?: ProxyService;
  private domainsService?: DomainsService;
  private eventBus?: EventBusService;
  private registry?: Pick<NodeRegistryService, 'getNode'>;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly deps: IngressGroupServiceDeps
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

  private viewContext(): IngressGroupViewContext {
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
  private async requireMemberCandidate(nodeId: string) {
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

  async create(input: CreateIngressGroupInput, userId: string): Promise<IngressGroupView> {
    for (const nodeId of input.nodeIds) await this.requireMemberCandidate(nodeId);
    const group = await writeWithAllocatedSlug({
      source: input.name,
      fallback: 'ingress-group',
      reserved: ['new'],
      constraint: GROUP_SLUG_CONSTRAINT,
      write: (slug) =>
        this.db.transaction(async (tx) => {
          const [created] = await tx
            .insert(ingressGroups)
            .values({
              name: input.name,
              slug,
              description: input.description ?? null,
              folderId: input.folderId ?? null,
              createdById: userId,
            })
            .returning();
          await tx.insert(ingressGroupMembers).values(
            input.nodeIds.map((nodeId, priority) => ({
              groupId: created!.id,
              nodeId,
              priority,
              state: 'active' as const,
            }))
          );
          return created!;
        }),
    });
    await this.auditService.log({
      userId,
      action: 'ingress_group.create',
      resourceType: 'ingress_group',
      resourceId: group.id,
      details: { name: group.name, nodeIds: input.nodeIds, folderId: group.folderId },
    });
    this.emit(group.id, 'created');
    return this.getSummary(group.id);
  }

  async update(id: string, input: UpdateIngressGroupInput, userId: string): Promise<IngressGroupView> {
    const existing = await this.requireGroup(id);
    const nameChanged = input.name !== undefined && input.name !== existing.name;
    const write = async (slug?: string) => {
      const [updated] = await this.db
        .update(ingressGroups)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
          ...(input.dnsFailoverMode !== undefined ? { dnsFailoverMode: input.dnsFailoverMode } : {}),
          ...(slug ? { slug } : {}),
          updatedAt: new Date(),
        })
        .where(eq(ingressGroups.id, id))
        .returning();
      return updated!;
    };
    if (nameChanged) {
      await writeWithAllocatedSlug({
        source: input.name!,
        fallback: 'ingress-group',
        reserved: ['new'],
        constraint: GROUP_SLUG_CONSTRAINT,
        write,
      });
    } else {
      await write();
    }
    await this.auditService.log({
      userId,
      action: 'ingress_group.update',
      resourceType: 'ingress_group',
      resourceId: id,
      details: { changes: Object.keys(input) },
    });
    this.emit(id, 'updated');
    return this.getSummary(id);
  }

  async delete(id: string, userId: string): Promise<void> {
    const group = await this.requireGroup(id);
    const [[routes], [domainCount]] = await Promise.all([
      this.db.select({ total: sql<number>`count(*)::int` }).from(proxyHosts).where(eq(proxyHosts.ingressGroupId, id)),
      this.db.select({ total: sql<number>`count(*)::int` }).from(domains).where(eq(domains.ingressGroupId, id)),
    ]);
    if ((routes?.total ?? 0) > 0 || (domainCount?.total ?? 0) > 0) {
      throw new AppError(
        409,
        'INGRESS_GROUP_IN_USE',
        'Move the routes and domains of this ingress group to one node (or delete them) before deleting the group',
        { routeCount: routes?.total ?? 0, domainCount: domainCount?.total ?? 0 }
      );
    }
    await this.db.delete(ingressGroups).where(eq(ingressGroups.id, id));
    await this.auditService.log({
      userId,
      action: 'ingress_group.delete',
      resourceType: 'ingress_group',
      resourceId: id,
      details: { name: group.name },
    });
    this.emit(id, 'deleted');
  }

  /** Hosts of a group, for membership operations. */
  private async groupHostIds(groupId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: proxyHosts.id })
      .from(proxyHosts)
      .where(eq(proxyHosts.ingressGroupId, groupId));
    return rows.map((row) => row.id);
  }

  /**
   * Adds a member without downtime: its row starts `joining` (served routes, no DNS), every route of the group is
   * delivered to it (secure-link sources, Pages artifacts, config, certificates), and only then is it promoted to
   * `active` and published in DNS. An offline node, or a route that did not reach it, keeps it joining; the
   * convergence reconciler retries and promotes it once it caught up.
   */
  async addMember(id: string, input: AddIngressGroupMemberInput, userId: string): Promise<IngressGroupView> {
    await this.requireGroup(id);
    await this.requireMemberCandidate(input.nodeId);
    await assertNodeAllowsServiceCreation(this.db, input.nodeId, 'nginx');
    const hostIds = await this.groupHostIds(id);
    await withProxyLocks([ingressGroupLockKey(id), proxyNodeLockKey(input.nodeId)], async () => {
      const members = await ingressGroupMemberRows(this.db, id);
      if (members.some((member) => member.nodeId === input.nodeId)) {
        throw new AppError(409, 'INGRESS_GROUP_MEMBER_EXISTS', 'The node is already a member of this ingress group');
      }
      const position = Math.min(input.position ?? members.length, members.length);
      await this.db
        .transaction(async (tx) => {
          // Renumber so the new member takes `position` in the site-preference order.
          const ordered = [...members];
          for (const [index, member] of ordered.entries()) {
            const priority = index < position ? index : index + 1;
            if (member.priority !== priority) {
              await tx
                .update(ingressGroupMembers)
                .set({ priority, updatedAt: new Date() })
                .where(and(eq(ingressGroupMembers.groupId, id), eq(ingressGroupMembers.nodeId, member.nodeId)));
            }
          }
          // The domain trigger refuses a name another enabled route already serves on this node.
          await tx
            .insert(ingressGroupMembers)
            .values({ groupId: id, nodeId: input.nodeId, priority: position, state: 'joining' });
        })
        .catch((error) => rethrowProxyHostDomainConflict(this.db, error));
    });
    await this.auditService.log({
      userId,
      action: 'ingress_group.member_add',
      resourceType: 'ingress_group',
      resourceId: id,
      details: { nodeId: input.nodeId, position: input.position ?? null, routeCount: hostIds.length },
    });
    await this.completeJoin(id, input.nodeId);
    this.emit(id, 'member_added');
    return this.getSummary(id);
  }

  /**
   * Delivers every route of the group to a joining member and promotes it when all of them reached it. Returns
   * whether the member is active now. Used by addMember and by the convergence reconciler.
   */
  async completeJoin(groupId: string, nodeId: string): Promise<boolean> {
    const proxy = this.requireProxy();
    const errors: string[] = [];
    if (!this.deps.isNodeConnected(nodeId)) {
      errors.push('The node is offline; it joins when it reconnects');
    } else {
      for (const hostId of await this.groupHostIds(groupId)) {
        try {
          await proxy.applyIngressMemberJoin(hostId, nodeId);
        } catch (error) {
          errors.push(`${hostId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return withProxyLocks([ingressGroupLockKey(groupId)], async () => {
      const [member] = await this.db
        .select()
        .from(ingressGroupMembers)
        .where(and(eq(ingressGroupMembers.groupId, groupId), eq(ingressGroupMembers.nodeId, nodeId)))
        .limit(1);
      if (!member || member.state !== 'joining') return member?.state === 'active';
      if (errors.length > 0) {
        await this.db
          .update(ingressGroupMembers)
          .set({ lastError: errors.join('; ').slice(0, 2000), updatedAt: new Date() })
          .where(and(eq(ingressGroupMembers.groupId, groupId), eq(ingressGroupMembers.nodeId, nodeId)));
        return false;
      }
      await this.db
        .update(ingressGroupMembers)
        .set({ state: 'active', lastError: null, updatedAt: new Date() })
        .where(and(eq(ingressGroupMembers.groupId, groupId), eq(ingressGroupMembers.nodeId, nodeId)));
      await this.syncPrimaryMirrors(groupId);
      // Only now is the member's address published.
      await this.requireDomains()
        .reconcileIngressGroupDns(groupId)
        .catch((error) =>
          logger.warn('DNS of the ingress group is updated on the next reconciliation', {
            groupId,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      await this.auditService.log({
        userId: null,
        action: 'ingress_group.member_active',
        resourceType: 'ingress_group',
        resourceId: groupId,
        details: { nodeId },
      });
      this.emit(groupId, 'member_active');
      return true;
    });
  }

  /**
   * Removes a member without downtime: DNS first (the member is `draining`: it keeps serving, but is no longer
   * published), then its config, certificates, secure-link sources and Pages artifacts once no public name resolves
   * to it (the convergence reconciler finishes the drain; at most 24 hours). `force` finishes at once. A joining
   * member was never published and is removed at once.
   */
  async removeMember(
    id: string,
    nodeId: string,
    input: RemoveIngressGroupMemberInput,
    userId: string
  ): Promise<IngressGroupView> {
    await this.requireGroup(id);
    const finishNow = await withProxyLocks([ingressGroupLockKey(id)], async () => {
      const members = await ingressGroupMemberRows(this.db, id);
      const member = members.find((candidate) => candidate.nodeId === nodeId);
      if (!member) throw new AppError(404, 'INGRESS_GROUP_MEMBER_NOT_FOUND', 'The node is not a member of this group');
      const remainingActive = members.filter(
        (candidate) => candidate.nodeId !== nodeId && candidate.state === 'active'
      );
      const hostIds = await this.groupHostIds(id);
      const [domainRow] = await this.db
        .select({ id: domains.id })
        .from(domains)
        .where(eq(domains.ingressGroupId, id))
        .limit(1);
      if (remainingActive.length === 0 && (hostIds.length > 0 || domainRow)) {
        throw new AppError(
          409,
          'INGRESS_GROUP_LAST_MEMBER',
          'This is the last active member of a group that still serves routes or domains: add another member first, or move them to one node'
        );
      }
      if (member.state === 'draining' && !input.force) return false;
      await this.db
        .update(ingressGroupMembers)
        .set({
          state: 'draining',
          drainStartedAt: sql`coalesce(${ingressGroupMembers.drainStartedAt}, now())`,
          updatedAt: new Date(),
        })
        .where(and(eq(ingressGroupMembers.groupId, id), eq(ingressGroupMembers.nodeId, nodeId)));
      await this.syncPrimaryMirrors(id);
      return input.force === true || member.state === 'joining';
    });
    await this.auditService.log({
      userId,
      action: 'ingress_group.member_remove',
      resourceType: 'ingress_group',
      resourceId: id,
      details: { nodeId, force: input.force === true },
    });
    // DNS first: the member's address leaves every Cloudflare-managed domain of the group.
    const dns = await this.requireDomains().reconcileIngressGroupDns(id);
    if (finishNow) {
      await this.finishDrain(id, nodeId, { reason: input.force ? 'forced' : 'joining' });
    } else if (!dns.settled) {
      await this.recordMemberError(id, nodeId, 'Waiting for DNS of the group’s domains to stop listing this member');
    }
    this.emit(id, 'member_draining');
    return this.getSummary(id);
  }

  async recordMemberError(groupId: string, nodeId: string, message: string | null) {
    await this.db
      .update(ingressGroupMembers)
      .set({ lastError: message, updatedAt: new Date() })
      .where(and(eq(ingressGroupMembers.groupId, groupId), eq(ingressGroupMembers.nodeId, nodeId)));
  }

  /**
   * The end of a drain: the member row goes (its domain rows with it), then every route of the group leaves the
   * node. Idempotent; a failure on an unreachable node is repaired by its reconnect resync.
   */
  async finishDrain(groupId: string, nodeId: string, details: Record<string, unknown> = {}): Promise<void> {
    const proxy = this.requireProxy();
    const hostIds = await this.groupHostIds(groupId);
    await withProxyLocks([ingressGroupLockKey(groupId)], async () => {
      await this.db
        .delete(ingressGroupMembers)
        .where(
          and(
            eq(ingressGroupMembers.groupId, groupId),
            eq(ingressGroupMembers.nodeId, nodeId),
            eq(ingressGroupMembers.state, 'draining')
          )
        );
      await this.syncPrimaryMirrors(groupId);
    });
    const failures: string[] = [];
    for (const hostId of hostIds) {
      try {
        await proxy.applyIngressMemberLeave(hostId, nodeId);
      } catch (error) {
        failures.push(`${hostId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.auditService.log({
      userId: null,
      action: 'ingress_group.member_removed',
      resourceType: 'ingress_group',
      resourceId: groupId,
      details: { nodeId, ...details, cleanupFailures: failures },
    });
    if (failures.length > 0) {
      logger.warn('A removed ingress group member keeps some route configs until its reconnect resync', {
        groupId,
        nodeId,
        failures,
      });
    }
    this.emit(groupId, 'member_removed');
  }

  /** New site-preference order; the first active member becomes the primary mirrored into routes and domains. */
  async reorder(id: string, nodeIds: string[], userId: string): Promise<IngressGroupView> {
    await this.requireGroup(id);
    await withProxyLocks([ingressGroupLockKey(id)], async () => {
      const members = await ingressGroupMemberRows(this.db, id);
      const current = members.map((member) => member.nodeId).sort();
      if (current.length !== nodeIds.length || [...nodeIds].sort().some((nodeId, index) => nodeId !== current[index])) {
        throw new AppError(400, 'INGRESS_GROUP_ORDER_INVALID', 'Pass every member of the group exactly once');
      }
      await this.db.transaction(async (tx) => {
        for (const [priority, nodeId] of nodeIds.entries()) {
          await tx
            .update(ingressGroupMembers)
            .set({ priority, updatedAt: new Date() })
            .where(and(eq(ingressGroupMembers.groupId, id), eq(ingressGroupMembers.nodeId, nodeId)));
        }
      });
      await this.syncPrimaryMirrors(id);
    });
    await this.auditService.log({
      userId,
      action: 'ingress_group.reorder',
      resourceType: 'ingress_group',
      resourceId: id,
      details: { nodeIds },
    });
    this.emit(id, 'reordered');
    return this.getSummary(id);
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
