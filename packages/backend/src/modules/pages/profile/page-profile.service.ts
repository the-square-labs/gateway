import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  domains,
  nodes,
  pageDeployments,
  pageProjects,
  pageWildcardProfiles,
  sslCertificates,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { PAGE_EVENT_CHANNELS, pageProjectEvent } from '../page-events.js';
import { compareRegistrableDomains, normalizePagesHostname } from './page-domain-isolation.js';
import { hasRequiredNginxPagesCapabilities } from './page-node-capability.js';
import type { UpdatePageProfileInput } from './page-profile.schemas.js';

const PROFILE_ID = 'default';

export interface PageProfileRuntimeAdapter {
  apply(profile: { domain: string; certificateId: string; labelTemplate: string }): Promise<void>;
  disable(profile: { domain: string }): Promise<void>;
  cleanupNode?(profile: { domain: string; nodeId: string }): Promise<void>;
}

function certificateCovers(certificateDomains: string[], wildcardDomain: string): boolean {
  const expected = `*.${normalizePagesHostname(wildcardDomain)}`;
  return certificateDomains.some((domain) => domain.trim().toLowerCase().replace(/\.$/, '') === expected);
}

export function renderPageHostname(labelTemplate: string, hash: string, project: string, domain: string): string {
  const label = labelTemplate.replace('{hash}', hash).replace('{project}', project);
  if (label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
    throw new AppError(409, 'PAGES_PREVIEW_LABEL_INVALID', 'Template renders an invalid DNS label for this Project');
  }
  return `${label}.${normalizePagesHostname(domain)}`;
}

export class PageProfileService {
  private eventBus?: EventBusService;
  private runtimeAdapter?: PageProfileRuntimeAdapter;
  private readonly gatewayHost: string;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    appUrl: string
  ) {
    this.gatewayHost = new URL(appUrl).hostname;
  }

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  setRuntimeAdapter(adapter: PageProfileRuntimeAdapter): void {
    this.runtimeAdapter = adapter;
  }

  async get() {
    const [profile] = await this.db
      .select()
      .from(pageWildcardProfiles)
      .where(eq(pageWildcardProfiles.id, PROFILE_ID))
      .limit(1);
    if (!profile) return { enabled: false, status: 'disabled', id: PROFILE_ID };
    const [domain, node, certificate] = await Promise.all([
      profile.domainId
        ? this.db
            .select()
            .from(domains)
            .where(eq(domains.id, profile.domainId))
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : null,
      profile.nodeId
        ? this.db
            .select()
            .from(nodes)
            .where(eq(nodes.id, profile.nodeId))
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : null,
      profile.certificateId
        ? this.db
            .select({
              id: sslCertificates.id,
              name: sslCertificates.name,
              domainNames: sslCertificates.domainNames,
              status: sslCertificates.status,
              notAfter: sslCertificates.notAfter,
            })
            .from(sslCertificates)
            .where(eq(sslCertificates.id, profile.certificateId))
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : null,
    ]);
    const isolation = domain ? compareRegistrableDomains(this.gatewayHost, domain.domain) : null;
    const overrideCurrent = Boolean(
      isolation?.same &&
        profile.overrideSameRegistrableDomain &&
        profile.overrideComparedHosts?.gatewayHost === isolation.gatewayHost &&
        profile.overrideComparedHosts.pagesHost === isolation.pagesHost
    );
    return {
      ...profile,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
      overrideAcknowledgedAt: profile.overrideAcknowledgedAt?.toISOString() ?? null,
      domain: domain
        ? {
            id: domain.id,
            domain: domain.domain,
            dnsStatus: domain.dnsStatus,
            nginxNodeId: domain.nginxNodeId,
          }
        : null,
      node: node
        ? {
            id: node.id,
            displayName: node.displayName,
            hostname: node.hostname,
            status: node.status,
            pagesCapable: hasRequiredNginxPagesCapabilities(node.capabilities),
          }
        : null,
      certificate,
      isolation: isolation
        ? {
            ...isolation,
            overrideRequired: isolation.same && !overrideCurrent,
            overrideCurrent,
          }
        : null,
    };
  }

  async getOptions() {
    const [domainRows, nodeRows, certificateRows] = await Promise.all([
      this.db
        .select({
          id: domains.id,
          domain: domains.domain,
          dnsStatus: domains.dnsStatus,
          nginxNodeId: domains.nginxNodeId,
        })
        .from(domains),
      this.db
        .select({
          id: nodes.id,
          displayName: nodes.displayName,
          hostname: nodes.hostname,
          status: nodes.status,
          capabilities: nodes.capabilities,
        })
        .from(nodes)
        .where(eq(nodes.type, 'nginx')),
      this.db
        .select({
          id: sslCertificates.id,
          name: sslCertificates.name,
          domainNames: sslCertificates.domainNames,
          status: sslCertificates.status,
          notAfter: sslCertificates.notAfter,
        })
        .from(sslCertificates)
        .where(eq(sslCertificates.status, 'active')),
    ]);
    return {
      domains: domainRows
        .filter((domain) => domain.domain.startsWith('*.'))
        .map((domain) => ({
          ...domain,
          isolation: compareRegistrableDomains(this.gatewayHost, domain.domain),
        })),
      nodes: nodeRows.map(({ capabilities, ...node }) => ({
        ...node,
        pagesCapable: hasRequiredNginxPagesCapabilities(capabilities),
      })),
      certificates: certificateRows.map((certificate) => ({
        ...certificate,
        notAfter: certificate.notAfter?.toISOString() ?? null,
      })),
    };
  }

  async configure(
    input: UpdatePageProfileInput,
    userId: string,
    internal: { allowDnsPending?: boolean; suppressPreviousNodeCleanup?: boolean } = {}
  ) {
    if (!input.enabled) return this.disable(userId);
    let selection: Awaited<ReturnType<PageProfileService['validateSelection']>>;
    try {
      selection = await this.validateSelection(input.domainId, input.certificateId, !internal.allowDnsPending);
    } catch (error) {
      if (error instanceof AppError && error.code === 'PAGES_DAEMON_UPDATE_REQUIRED') {
        await this.emitForProjects('capability.missing', error.code, input.nodeId);
      }
      throw error;
    }
    const isolation = compareRegistrableDomains(this.gatewayHost, selection.baseDomain);
    if (isolation.same && !input.acknowledgeSameRegistrableDomain) {
      throw new AppError(
        409,
        'PAGES_DOMAIN_ISOLATION_OVERRIDE_REQUIRED',
        'Pages should use a separate registrable domain because deployed JavaScript can affect parent-domain cookies',
        isolation
      );
    }
    await this.assertDomainReplacementAllowed(selection.domain.id);
    const [previous] = await this.db
      .select()
      .from(pageWildcardProfiles)
      .where(eq(pageWildcardProfiles.id, PROFILE_ID))
      .limit(1);

    const [profile] = await this.db
      .insert(pageWildcardProfiles)
      .values({
        id: PROFILE_ID,
        enabled: true,
        domainId: selection.domain.id,
        nodeId: input.nodeId ?? selection.domain.nginxNodeId,
        certificateId: selection.certificate.id,
        labelTemplate: input.labelTemplate,
        status: 'pending',
        overrideSameRegistrableDomain: isolation.same,
        overrideComparedHosts: isolation.same
          ? { gatewayHost: isolation.gatewayHost, pagesHost: isolation.pagesHost }
          : null,
        overrideAcknowledgedById: isolation.same ? userId : null,
        overrideAcknowledgedAt: isolation.same ? new Date() : null,
        lastErrorCode: null,
        lastErrorMessage: null,
        createdById: userId,
        updatedById: userId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: pageWildcardProfiles.id,
        set: {
          enabled: true,
          domainId: selection.domain.id,
          nodeId: input.nodeId ?? selection.domain.nginxNodeId,
          certificateId: selection.certificate.id,
          labelTemplate: input.labelTemplate,
          status: 'pending',
          overrideSameRegistrableDomain: isolation.same,
          overrideComparedHosts: isolation.same
            ? { gatewayHost: isolation.gatewayHost, pagesHost: isolation.pagesHost }
            : null,
          overrideAcknowledgedById: isolation.same ? userId : null,
          overrideAcknowledgedAt: isolation.same ? new Date() : null,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedById: userId,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!profile) throw new AppError(500, 'PAGES_PROFILE_SAVE_FAILED', 'Pages profile was not saved');

    await this.auditService.log({
      userId,
      action: 'page_profile.configure',
      resourceType: 'page_profile',
      resourceId: PROFILE_ID,
      details: {
        domainId: selection.domain.id,
        nodeId: input.nodeId ?? selection.domain.nginxNodeId,
        certificateId: selection.certificate.id,
        labelTemplate: input.labelTemplate,
        sameRegistrableDomainOverride: isolation.same,
        comparedHosts: isolation.same ? { gatewayHost: isolation.gatewayHost, pagesHost: isolation.pagesHost } : null,
      },
    });
    await this.reconcile(internal.allowDnsPending);
    const configured = await this.get();
    if (
      configured.status === 'ready' &&
      previous?.enabled &&
      previous.nodeId &&
      previous.nodeId !== (input.nodeId ?? selection.domain.nginxNodeId) &&
      !internal.suppressPreviousNodeCleanup
    ) {
      await this.runtimeAdapter
        ?.cleanupNode?.({ domain: selection.baseDomain, nodeId: previous.nodeId })
        .catch(() => undefined);
    }
    return configured;
  }

  async migrateDomainIngress(domainIds: string[], targetNodeId: string, userId: string): Promise<void> {
    const [profile] = await this.db
      .select()
      .from(pageWildcardProfiles)
      .where(and(eq(pageWildcardProfiles.id, PROFILE_ID), eq(pageWildcardProfiles.enabled, true)))
      .limit(1);
    if (!profile?.domainId || !domainIds.includes(profile.domainId) || profile.nodeId === targetNodeId) return;
    if (!profile.certificateId) throw new AppError(409, 'PAGES_PROFILE_INVALID', 'Pages profile is incomplete');
    const configured = await this.configure(
      {
        enabled: true,
        domainId: profile.domainId,
        nodeId: targetNodeId,
        certificateId: profile.certificateId,
        labelTemplate: profile.labelTemplate,
        acknowledgeSameRegistrableDomain: profile.overrideSameRegistrableDomain,
      },
      userId,
      { allowDnsPending: true, suppressPreviousNodeCleanup: true }
    );
    if (configured.status !== 'ready') {
      throw new AppError(
        409,
        'PAGES_PROFILE_MIGRATION_FAILED',
        'Pages previews could not be staged on the target node'
      );
    }
  }

  async cleanupMigratedSource(domainIds: string[], sourceNodeId: string): Promise<void> {
    const [profile] = await this.db
      .select({ domainId: pageWildcardProfiles.domainId, nodeId: pageWildcardProfiles.nodeId, domain: domains.domain })
      .from(pageWildcardProfiles)
      .innerJoin(domains, eq(pageWildcardProfiles.domainId, domains.id))
      .where(and(eq(pageWildcardProfiles.id, PROFILE_ID), eq(pageWildcardProfiles.enabled, true)))
      .limit(1);
    if (!profile?.domainId || !domainIds.includes(profile.domainId) || profile.nodeId === sourceNodeId) return;
    await this.runtimeAdapter?.cleanupNode?.({ domain: normalizePagesHostname(profile.domain), nodeId: sourceNodeId });
  }

  async disable(userId: string) {
    const [existing] = await this.db
      .select()
      .from(pageWildcardProfiles)
      .where(eq(pageWildcardProfiles.id, PROFILE_ID))
      .limit(1);
    if (!existing?.enabled) return this.get();
    if (!existing.domainId) throw new AppError(409, 'PAGES_PROFILE_INVALID', 'Pages profile is incomplete');
    const [domain] = await this.db.select().from(domains).where(eq(domains.id, existing.domainId)).limit(1);
    if (!domain) throw new AppError(409, 'PAGES_PROFILE_INVALID', 'Pages profile is incomplete');
    if (!this.runtimeAdapter) throw new AppError(503, 'PAGES_RUNTIME_UNAVAILABLE', 'Pages runtime is unavailable');
    await this.runtimeAdapter.disable({ domain: normalizePagesHostname(domain.domain) });
    await this.db
      .update(pageWildcardProfiles)
      .set({ enabled: false, status: 'disabled', updatedById: userId, updatedAt: new Date() })
      .where(eq(pageWildcardProfiles.id, PROFILE_ID));
    await this.auditService.log({
      userId,
      action: 'page_profile.disable',
      resourceType: 'page_profile',
      resourceId: PROFILE_ID,
      details: { domainId: domain.id },
    });
    return this.get();
  }

  async reconcile(allowDnsPending = false): Promise<void> {
    const [profile] = await this.db
      .select()
      .from(pageWildcardProfiles)
      .where(and(eq(pageWildcardProfiles.id, PROFILE_ID), eq(pageWildcardProfiles.enabled, true)))
      .limit(1);
    if (!profile?.domainId || !profile.certificateId) return;
    if (!this.runtimeAdapter) {
      await this.setFailure('pending', 'PAGES_RUNTIME_UNAVAILABLE');
      return;
    }
    try {
      const selection = await this.validateSelection(profile.domainId, profile.certificateId, !allowDnsPending);
      await this.runtimeAdapter.apply({
        domain: selection.baseDomain,
        certificateId: selection.certificate.id,
        labelTemplate: profile.labelTemplate,
      });
      await this.db
        .update(pageWildcardProfiles)
        .set({ status: 'ready', lastErrorCode: null, lastErrorMessage: null, updatedAt: new Date() })
        .where(eq(pageWildcardProfiles.id, PROFILE_ID));
      await this.emitForProjects('profile.healthy');
      await this.emitForProjects('capability.restored');
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'PAGES_PROFILE_APPLY_FAILED';
      if (code === 'PAGES_DAEMON_UPDATE_REQUIRED') {
        await this.setFailure('capability_missing', code);
        await this.emitForProjects('capability.missing', code, profile.nodeId ?? undefined);
      } else {
        await this.setFailure('degraded', code);
        await this.emitForProjects('profile.unavailable', code);
      }
    }
  }

  async assignImmutableHostname(deploymentId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ deployment: pageDeployments, project: pageProjects, profile: pageWildcardProfiles, domain: domains })
      .from(pageDeployments)
      .innerJoin(pageProjects, eq(pageDeployments.projectId, pageProjects.id))
      .innerJoin(
        pageWildcardProfiles,
        and(eq(pageWildcardProfiles.id, PROFILE_ID), eq(pageWildcardProfiles.enabled, true))
      )
      .innerJoin(domains, eq(pageWildcardProfiles.domainId, domains.id))
      .where(eq(pageDeployments.id, deploymentId))
      .limit(1);
    if (!row) return null;
    if (row.deployment.previewHostname) return row.deployment.previewHostname;
    const hostname = renderPageHostname(
      row.profile.labelTemplate,
      row.deployment.publicSlug,
      row.project.slug,
      row.domain.domain
    );
    const [updated] = await this.db
      .update(pageDeployments)
      .set({ previewHostname: hostname, updatedAt: new Date() })
      .where(and(eq(pageDeployments.id, deploymentId), isNull(pageDeployments.previewHostname)))
      .returning({ previewHostname: pageDeployments.previewHostname });
    if (updated?.previewHostname) return updated.previewHostname;
    const [existing] = await this.db
      .select({ previewHostname: pageDeployments.previewHostname })
      .from(pageDeployments)
      .where(eq(pageDeployments.id, deploymentId))
      .limit(1);
    return existing?.previewHostname ?? null;
  }

  private async validateSelection(domainId: string, certificateId: string, requireDnsReady = true) {
    const [[domain], [certificate]] = await Promise.all([
      this.db.select().from(domains).where(eq(domains.id, domainId)).limit(1),
      this.db.select().from(sslCertificates).where(eq(sslCertificates.id, certificateId)).limit(1),
    ]);
    if (!domain?.domain.startsWith('*.')) {
      throw new AppError(400, 'PAGES_WILDCARD_DOMAIN_REQUIRED', 'Select a registered wildcard Domain');
    }
    if (requireDnsReady && domain.dnsStatus !== 'valid') {
      throw new AppError(409, 'PAGES_DOMAIN_DNS_NOT_READY', 'Wildcard Domain DNS is not valid yet');
    }
    const baseDomain = normalizePagesHostname(domain.domain);
    if (
      !certificate ||
      certificate.status !== 'active' ||
      (certificate.notAfter && certificate.notAfter.getTime() <= Date.now()) ||
      !certificateCovers(certificate.domainNames, baseDomain)
    ) {
      throw new AppError(409, 'PAGES_CERTIFICATE_INVALID', 'Select an active certificate covering the wildcard Domain');
    }
    return { domain, certificate, baseDomain };
  }

  private async assertDomainReplacementAllowed(nextDomainId: string): Promise<void> {
    const [current] = await this.db
      .select({ domainId: pageWildcardProfiles.domainId })
      .from(pageWildcardProfiles)
      .where(eq(pageWildcardProfiles.id, PROFILE_ID))
      .limit(1);
    if (!current?.domainId || current.domainId === nextDomainId) return;
    const [{ retainedCount }] = await this.db
      .select({ retainedCount: count() })
      .from(pageDeployments)
      .where(inArray(pageDeployments.status, ['stored', 'staging', 'ready', 'cleaning']));
    if (retainedCount > 0) {
      throw new AppError(
        409,
        'PAGES_DOMAIN_REPLACEMENT_BLOCKED',
        'Disable previews and remove retained published Deployments before replacing the Pages Domain',
        { retainedCount }
      );
    }
  }

  private async setFailure(status: 'pending' | 'degraded' | 'capability_missing', code: string): Promise<void> {
    await this.db
      .update(pageWildcardProfiles)
      .set({ status, lastErrorCode: code.slice(0, 128), lastErrorMessage: null, updatedAt: new Date() })
      .where(eq(pageWildcardProfiles.id, PROFILE_ID));
  }

  private async emitForProjects(action: string, failureCode?: string, nodeId?: string): Promise<void> {
    if (!this.eventBus) return;
    const projects = await this.db.select({ id: pageProjects.id }).from(pageProjects);
    for (const project of projects) {
      this.eventBus.publish(
        PAGE_EVENT_CHANNELS.profile,
        pageProjectEvent(project.id, action, { id: PROFILE_ID, failureCode: failureCode ?? null, nodeId })
      );
    }
  }
}
