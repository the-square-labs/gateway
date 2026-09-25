import { eq } from 'drizzle-orm';
import { accessLists } from '@/db/schema/access-lists.js';
import { certificates } from '@/db/schema/certificates.js';
import { proxyHosts } from '@/db/schema/index.js';
import { sslCertificates } from '@/db/schema/ssl-certificates.js';
import { AppError } from '@/middleware/error-handler.js';
import { stripProxyHealthHistory } from './proxy.service-helpers.js';
import { withProxyHostLock } from './proxy-host-lock.js';
import type { CreateProxyAdditionalSecureLinkInput } from './proxy-secure-link.service.js';
import { attachDockerUpstreamDisplay } from './proxy-upstream-display.js';

export { __testOnly } from './proxy.service-helpers.js';

import { logger } from './proxy.service.core.js';
import { ProxyServiceMutations } from './proxy.service.mutations.js';

export abstract class ProxyServiceLifecycle extends ProxyServiceMutations {
  // One replaceable token fences stale collection snapshots, without retaining
  // deleted resource IDs. Already-started samples have their own write leases.
  protected secureLinkRuntimeCollectionEpoch: object = {};

  async deleteProxyHost(id: string, userId: string, options: { abandonOfflineNode?: boolean } = {}) {
    return withProxyHostLock(id, () => this.deleteProxyHostLocked(id, userId, options));
  }

  private async deleteProxyHostLocked(id: string, userId: string, options: { abandonOfflineNode?: boolean }) {
    // 1. Get existing host
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
    });
    if (!existing) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (existing.isSystem && !options.abandonOfflineNode) {
      throw new AppError(403, 'SYSTEM_HOST', 'System proxy hosts cannot be deleted');
    }
    // Capture child keys before cleanup removes the bindings from persistence.
    const additionalLinks = (await this.secureLinks?.listAdditional?.(id)) ?? [];

    const abandoningOfflineNode = options.abandonOfflineNode === true;
    if (abandoningOfflineNode) {
      if (this.nodeDispatch.isNodeConnected(existing.nodeId)) {
        throw new AppError(409, 'NGINX_NODE_CONNECTED', 'Connected Nginx nodes require confirmed config cleanup');
      }
      if (existing.nodeId) {
        await this.certificateDistribution.deactivateHost(id, existing.nodeId);
      }
      await this.secureLinks?.abandonOfflineSource(existing);
    } else {
      // Preserve the currently active deployment until Nginx has confirmed
      // the config removal. This avoids GCing a certificate for a still-serving host.
      try {
        await this.removeConfigFromNode(id, existing.nodeId);
        await this.certificateDistribution.deactivateHost(id, existing.nodeId);
      } catch (error) {
        throw new AppError(
          500,
          'NGINX_CONFIG_FAILED',
          `Failed to remove Nginx config: ${error instanceof Error ? error.message : 'unknown error'}`
        );
      }
    }

    // 3. Delete the database row only after the active deployment is safely gone.
    if (!abandoningOfflineNode) {
      await this.secureLinks?.cleanupAdditionalForHost(existing);
      await this.secureLinks?.cleanup(existing);
    }
    if (existing.upstreamKind === 'pages') {
      await this.pageRoutes?.removeHost(id, existing.nodeId, abandoningOfflineNode);
    }
    await this.additionalRoutes?.cleanupForHost(existing, abandoningOfflineNode);
    try {
      await this.db.delete(proxyHosts).where(eq(proxyHosts.id, id));
    } catch (error) {
      if (existing.upstreamKind === 'pages') {
        await this.disablePageHostForDeferredCleanup(id, error);
      }
      throw error;
    }

    this.forgetSecureLinkRuntime(id);
    this.hostConfigEpochs.delete(id);
    for (const binding of additionalLinks) this.forgetSecureLinkRuntime(`additional:${binding.id}`);

    // 5. Audit log
    await this.auditService.log({
      userId,
      action: 'proxy_host.delete',
      resourceType: 'proxy_host',
      resourceId: id,
      details: {
        domainNames: existing.domainNames,
        abandonedOfflineNode: abandoningOfflineNode,
        ...(abandoningOfflineNode ? { nodeId: existing.nodeId, orphanedNginxConfigPossible: true } : {}),
      },
    });

    logger.info('Deleted proxy host', { hostId: id, domains: existing.domainNames });
    this.emitHost(id, 'deleted', existing.domainNames?.[0]);
    this.reconcileMaintenanceAlerts(id);
  }

  // -----------------------------------------------------------------------
  // Get single
  // -----------------------------------------------------------------------

  async getProxyHost(id: string) {
    const host = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
    });
    if (!host) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (host.isSystem) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');

    // Resolve relations
    const sslCert = host.sslCertificateId
      ? await this.db.query.sslCertificates.findFirst({
          where: eq(sslCertificates.id, host.sslCertificateId),
        })
      : null;

    const internalCert = host.internalCertificateId
      ? await this.db.query.certificates.findFirst({
          where: eq(certificates.id, host.internalCertificateId),
        })
      : null;

    const accessList = host.accessListId
      ? await this.db.query.accessLists.findFirst({
          where: eq(accessLists.id, host.accessListId),
        })
      : null;
    const tlsDistribution = await this.certificateDistribution.getStatusForHost(host);
    const [displayHost] = await attachDockerUpstreamDisplay(this.db, [host]);
    return {
      ...stripProxyHealthHistory(displayHost!),
      sslCertificate: sslCert
        ? {
            id: sslCert.id,
            name: sslCert.name,
            type: sslCert.type,
            domainNames: sslCert.domainNames,
            status: sslCert.status,
            notAfter: sslCert.notAfter,
          }
        : null,
      internalCertificate: internalCert
        ? {
            id: internalCert.id,
            commonName: internalCert.commonName,
            status: internalCert.status,
            notAfter: internalCert.notAfter,
          }
        : null,
      accessList: accessList
        ? {
            id: accessList.id,
            name: accessList.name,
          }
        : null,
      tlsDistribution,
      pageTarget: displayHost?.pageTarget ?? null,
    };
  }

  async getProxyHostBySlug(slug: string) {
    const host = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.slug, slug),
      columns: { id: true, isSystem: true },
    });
    if (!host || host.isSystem) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    return this.getProxyHost(host.id);
  }

  async getProxyHostHealthHistory(id: string) {
    const host = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
      columns: { id: true, isSystem: true, healthHistory: true },
    });
    if (!host) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (host.isSystem) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    return host.healthHistory ?? [];
  }

  async listAdditionalSecureLinks(id: string) {
    await this.requireManagedProxyHost(id);
    if (!this.secureLinks) throw new AppError(503, 'SECURE_LINK_UNAVAILABLE', 'Proxy Secure Links are unavailable');
    const [bindings, routes] = await Promise.all([
      this.secureLinks.listAllAdditional(id),
      this.additionalRoutes?.list(id) ?? Promise.resolve([]),
    ]);
    const routePaths = new Map(routes.map((route) => [route.id, route.path]));
    return bindings.map((binding) => ({
      ...binding,
      managedRoutePath:
        binding.purpose === 'additional_route' && binding.referenceId
          ? (routePaths.get(binding.referenceId) ?? null)
          : null,
    }));
  }

  async createAdditionalSecureLink(
    id: string,
    input: CreateProxyAdditionalSecureLinkInput,
    userId: string,
    actorScopes?: string[]
  ) {
    const host = await this.requireManagedProxyHost(id);
    if (!this.secureLinks) throw new AppError(503, 'SECURE_LINK_UNAVAILABLE', 'Proxy Secure Links are unavailable');
    const binding = await this.secureLinks.createAdditional(host, input, actorScopes);
    await this.auditService.log({
      userId,
      action: 'proxy_host.additional_secure_link.create',
      resourceType: 'proxy_host',
      resourceId: id,
      details: { bindingId: binding.id, name: binding.name, target: binding.targetContainer },
    });
    return binding;
  }

  async retryAdditionalSecureLink(id: string, bindingId: string, userId: string, actorScopes?: string[]) {
    const host = await this.requireManagedProxyHost(id);
    if (!this.secureLinks) throw new AppError(503, 'SECURE_LINK_UNAVAILABLE', 'Proxy Secure Links are unavailable');
    const binding = await this.secureLinks.retryAdditional(host, bindingId, actorScopes);
    await this.auditService.log({
      userId,
      action: 'proxy_host.additional_secure_link.retry',
      resourceType: 'proxy_host',
      resourceId: id,
      details: { bindingId, name: binding.name },
    });
    return binding;
  }

  /**
   * Points an Additional Secure Link at another target without deleting it,
   * so its name and id stay valid in the Route config. When the scheme
   * changes (a managed storage cluster with TLS replacing one without), the
   * Route config that renders the link upstream is applied again; when that
   * fails, the retarget fails and a managed storage link goes back to its
   * previous cluster.
   */
  async retargetAdditionalSecureLink(
    id: string,
    bindingId: string,
    input: Omit<CreateProxyAdditionalSecureLinkInput, 'name'>,
    userId: string,
    actorScopes?: string[]
  ) {
    const host = await this.requireManagedProxyHost(id);
    if (!this.secureLinks) throw new AppError(503, 'SECURE_LINK_UNAVAILABLE', 'Proxy Secure Links are unavailable');
    const before = (await this.secureLinks.listAdditional(id)).find((binding) => binding.id === bindingId);
    // The Route upstream for the link carries its scheme, so a scheme change
    // must reach nginx; a failure fails (and rolls back) the retarget. After
    // an attempt, the rollback applies the config again for the old scheme.
    let applied = false;
    const binding = await this.secureLinks.retargetAdditional(host, bindingId, input, actorScopes, async (link) => {
      if (!applied && before?.forwardScheme === link.forwardScheme) return;
      applied = true;
      await this.reapplyHostConfig(id);
    });
    await this.auditService.log({
      userId,
      action: 'proxy_host.additional_secure_link.retarget',
      resourceType: 'proxy_host',
      resourceId: id,
      details: {
        bindingId,
        name: binding.name,
        from: before
          ? {
              upstreamKind: before.upstreamKind,
              managedStorageId: before.managedStorageId,
              target: before.targetContainer,
            }
          : null,
        to: {
          upstreamKind: binding.upstreamKind,
          managedStorageId: binding.managedStorageId,
          target: binding.targetContainer,
        },
        status: binding.status,
      },
    });
    return binding;
  }

  async deleteAdditionalSecureLink(id: string, bindingId: string, userId: string) {
    const host = await this.requireManagedProxyHost(id);
    if (!this.secureLinks) throw new AppError(503, 'SECURE_LINK_UNAVAILABLE', 'Proxy Secure Links are unavailable');
    await this.secureLinks.deleteAdditional(host, bindingId);
    this.forgetSecureLinkRuntime(`additional:${bindingId}`);
    this.queueDockerReconciliation(true);
    await this.auditService.log({
      userId,
      action: 'proxy_host.additional_secure_link.delete',
      resourceType: 'proxy_host',
      resourceId: id,
      details: { bindingId },
    });
  }

  protected forgetSecureLinkRuntime(key: string): void {
    this.secureLinkRuntimeCollectionEpoch = {};
    this.secureLinkRuntimeHistory.delete(key);
    // The promise itself is the write lease: removing it fences late samples
    // without retaining a tombstone for every deleted host/binding.
    this.secureLinkRuntimeSamplesInFlight.delete(key);
  }
}
