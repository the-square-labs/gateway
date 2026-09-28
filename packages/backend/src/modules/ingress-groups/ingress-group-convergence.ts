import { and, eq, inArray, isNotNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  domains,
  ingressGroupMembers,
  ingressMemberDeliveries,
  nginxCertificateAssets,
  proxyHosts,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { IngressGroupService } from './ingress-group.service.js';

const logger = createChildLogger('IngressGroupConvergence');

/** A drain never waits longer: after this the member is cleaned up even if some resolver still returns it. */
export const INGRESS_MEMBER_MAX_DRAIN_MS = 24 * 60 * 60 * 1000;
/** Cloudflare "automatic" TTL (value 1) is 300 seconds for DNS-only records. */
const CLOUDFLARE_AUTO_TTL_SECONDS = 300;
/** A failed or pending member delivery is retried after this long. */
export const INGRESS_DELIVERY_RETRY_MS = 60 * 1000;

/**
 * Keeps every ingress group converged without an operator:
 * - joining members are promoted (and published in DNS) once every route reached them;
 * - draining members are cleaned up once DNS stopped pointing at them (TTL elapsed, no public name resolves to them);
 * - routes that did not reach a connected member (offline at the time, a failed push, a renewed certificate that
 *   missed it, a member row created by a race) are delivered again;
 * - the primary mirrored into routes and domains follows the member order.
 * Runs periodically and after nginx nodes reconnect.
 */
export class IngressGroupConvergence {
  private running: Promise<void> | null = null;
  private rerun = false;

  constructor(
    private readonly db: DrizzleClient,
    private readonly groups: IngressGroupService,
    private readonly isNodeConnected: (nodeId: string) => boolean
  ) {}

  /** Runs one pass (coalescing concurrent requests into one follow-up pass). */
  reconcile(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.rerun = false;
          await this.reconcileOnce();
        } while (this.rerun);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async reconcileOnce(now = Date.now()): Promise<void> {
    const members = await this.db.select().from(ingressGroupMembers);
    const groupIds = [...new Set(members.map((member) => member.groupId))];
    for (const groupId of groupIds) {
      await this.groups.syncPrimaryMirrors(groupId).catch((error) => this.warn('primary mirror', groupId, error));
    }
    for (const member of members.filter((candidate) => candidate.state === 'joining')) {
      if (!this.isNodeConnected(member.nodeId)) continue;
      await this.groups
        .completeJoin(member.groupId, member.nodeId)
        .catch((error) => this.warn('join', member.groupId, error));
    }
    for (const member of members.filter((candidate) => candidate.state === 'draining')) {
      await this.reconcileDrain(member, now).catch((error) => this.warn('drain', member.groupId, error));
    }
    await this.redeliverUnsettled(now).catch((error) => this.warn('delivery', null, error));
  }

  private async reconcileDrain(member: typeof ingressGroupMembers.$inferSelect, now: number): Promise<void> {
    const startedAt = member.drainStartedAt?.getTime() ?? now;
    const domainsService = this.groups.requireDomains();
    if (now - startedAt >= INGRESS_MEMBER_MAX_DRAIN_MS) {
      await this.groups.finishDrain(member.groupId, member.nodeId, { reason: 'drain_timeout' });
      return;
    }
    const dns = await domainsService.reconcileIngressGroupDns(member.groupId);
    if (!dns.settled) {
      await this.groups.recordMemberError(
        member.groupId,
        member.nodeId,
        `Waiting for DNS of ${dns.domains
          .filter((domain) => !domain.settled)
          .map((domain) => domain.domain)
          .join(', ')} to stop listing this member`
      );
      return;
    }
    // DNS-only Cloudflare records can be cached for their TTL; proxied records switch at Cloudflare's edge at once.
    const groupDomains = await this.db
      .select({ dnsProvider: domains.dnsProvider, dnsProxied: domains.dnsProxied, dnsTtl: domains.dnsTtl })
      .from(domains)
      .where(eq(domains.ingressGroupId, member.groupId));
    const ttlSeconds = Math.max(
      0,
      ...groupDomains
        .filter((domain) => domain.dnsProvider === 'cloudflare' && domain.dnsProxied !== true)
        .map((domain) => (domain.dnsTtl && domain.dnsTtl > 1 ? domain.dnsTtl : CLOUDFLARE_AUTO_TTL_SECONDS))
    );
    if (now - startedAt < ttlSeconds * 1000) {
      await this.groups.recordMemberError(
        member.groupId,
        member.nodeId,
        `Waiting ${Math.ceil((ttlSeconds * 1000 - (now - startedAt)) / 1000)} s for cached DNS answers to expire`
      );
      return;
    }
    const summary = await this.groups.getSummary(member.groupId);
    const addresses = summary.members.find((candidate) => candidate.nodeId === member.nodeId)?.node?.addresses ?? [];
    const stillPointing = await domainsService.ingressNamesStillPointAt(member.groupId, addresses);
    if (stillPointing.length > 0) {
      await this.groups.recordMemberError(
        member.groupId,
        member.nodeId,
        `Waiting for public DNS of ${stillPointing.slice(0, 5).join(', ')}${stillPointing.length > 5 ? ` and ${stillPointing.length - 5} more` : ''} to stop resolving to this member`
      );
      return;
    }
    await this.groups.finishDrain(member.groupId, member.nodeId, { reason: 'dns_moved' });
  }

  /**
   * Group routes whose delivery to a connected member is not confirmed, is missing, or carries an older certificate
   * version than the canonical asset: delivered to that member again.
   */
  private async redeliverUnsettled(now: number): Promise<void> {
    const retryBefore = new Date(now - INGRESS_DELIVERY_RETRY_MS);
    const pairs = await this.db
      .select({ hostId: proxyHosts.id, nodeId: ingressGroupMembers.nodeId })
      .from(proxyHosts)
      .innerJoin(ingressGroupMembers, eq(ingressGroupMembers.groupId, proxyHosts.ingressGroupId))
      .leftJoin(
        ingressMemberDeliveries,
        and(
          eq(ingressMemberDeliveries.hostId, proxyHosts.id),
          eq(ingressMemberDeliveries.nodeId, ingressGroupMembers.nodeId)
        )
      )
      .leftJoin(
        nginxCertificateAssets,
        or(
          and(
            eq(nginxCertificateAssets.referenceType, 'ssl'),
            eq(nginxCertificateAssets.referenceId, proxyHosts.sslCertificateId)
          ),
          and(
            sql`${proxyHosts.sslCertificateId} is null`,
            eq(nginxCertificateAssets.referenceType, 'internal'),
            eq(nginxCertificateAssets.referenceId, proxyHosts.internalCertificateId)
          )
        )
      )
      .where(
        and(
          isNotNull(proxyHosts.ingressGroupId),
          eq(proxyHosts.enabled, true),
          notInArray(ingressGroupMembers.state, ['draining']),
          or(
            sql`${ingressMemberDeliveries.hostId} is null`,
            and(
              inArray(ingressMemberDeliveries.status, ['pending', 'failed']),
              or(
                sql`${ingressMemberDeliveries.attemptedAt} is null`,
                lt(ingressMemberDeliveries.attemptedAt, retryBefore)
              )
            ),
            and(
              eq(proxyHosts.sslEnabled, true),
              eq(nginxCertificateAssets.state, 'ready'),
              sql`${ingressMemberDeliveries.appliedCertificateVersion} is distinct from ${nginxCertificateAssets.version}`,
              or(
                sql`${ingressMemberDeliveries.attemptedAt} is null`,
                lt(ingressMemberDeliveries.attemptedAt, retryBefore)
              )
            )
          )
        )
      )
      .limit(200);
    const proxy = this.groups.requireProxy();
    for (const pair of pairs) {
      if (!this.isNodeConnected(pair.nodeId)) continue;
      try {
        await proxy.redeliverIngressMember(pair.hostId, pair.nodeId);
      } catch (error) {
        logger.debug('Ingress group member delivery is retried later', {
          hostId: pair.hostId,
          nodeId: pair.nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private warn(step: string, groupId: string | null, error: unknown) {
    logger.warn('Ingress group convergence step failed; it is retried', {
      step,
      groupId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
