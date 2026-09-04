import { and, eq, inArray, ne, or } from 'drizzle-orm';
import { proxyHosts } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { runImmediateProxyHealthCheck } from './proxy-health-check.js';

export { __testOnly } from './proxy.service-helpers.js';

import { isDockerUpstream, logger, type ProxyHostRow } from './proxy.service.core.js';
import { ProxyServiceListing } from './proxy.service.listing.js';

export class ProxyServiceReconciliation extends ProxyServiceListing {
  async reconcileDockerContainerRecreate(_nodeId: string): Promise<void> {
    await this.reconcileDockerUpstreams(true);
  }

  protected runImmediateHealthCheck(hostId: string): void {
    runImmediateProxyHealthCheck({
      db: this.db,
      hostId,
      logger,
      nodeDispatch: this.nodeDispatch,
      eventBus: this.eventBus,
    });
  }

  protected async refreshExternalBranding(): Promise<void> {
    const hosts = await this.db.query.proxyHosts.findMany({
      where: and(eq(proxyHosts.enabled, true), or(eq(proxyHosts.type, '404'), eq(proxyHosts.maintenanceEnabled, true))),
    });
    for (const host of hosts) {
      const certPaths = await this.resolveCertPaths(host, { preserveLegacyOnUnsupported: true });
      const accessList = await this.resolveAccessList(host.accessListId);
      const config = await this.buildNginxConfig(host, certPaths, accessList);
      await this.applyConfigToNode(
        host.id,
        config,
        host.nodeId,
        certPaths.preparedTls,
        this.configOwnershipForHost(host),
        host.accessListId
      );
    }
  }

  protected queueDockerReconciliation(force = false): void {
    if (!this.dockerUpstreams) return;
    this.dockerReconcileDirty = true;
    this.dockerReconcileForce ||= force;
    if (this.dockerReconcileRunning) return;
    this.dockerReconcileRunning = true;
    void (async () => {
      try {
        do {
          this.dockerReconcileDirty = false;
          const reconcileForce = this.dockerReconcileForce;
          this.dockerReconcileForce = false;
          await this.reconcileDockerUpstreams(reconcileForce);
        } while (this.dockerReconcileDirty);
      } catch (error) {
        logger.error('Docker proxy upstream reconciliation failed', { error });
        this.scheduleDockerReconciliationRetry();
      } finally {
        this.dockerReconcileRunning = false;
        if (this.dockerReconcileDirty) this.queueDockerReconciliation();
        if (this.secureLinkRuntimeCollectionPending) {
          void this.collectSecureLinkRuntimeSnapshots();
        }
      }
    })();
  }

  protected scheduleDockerReconciliationRetry(): void {
    if (this.dockerReconcileRetry) return;
    const delay = this.dockerReconcileBackoffMs;
    this.dockerReconcileBackoffMs = Math.min(this.dockerReconcileBackoffMs * 2, 5 * 60_000);
    this.dockerReconcileRetry = setTimeout(() => {
      this.dockerReconcileRetry = undefined;
      this.queueDockerReconciliation(true);
    }, delay);
  }

  protected async updateRenamedContainerReferences(nodeId: string, oldName: string, newName: string): Promise<void> {
    const updated = await this.db
      .update(proxyHosts)
      .set({ dockerContainerName: newName, updatedAt: new Date() })
      .where(
        and(
          eq(proxyHosts.upstreamKind, 'docker_container'),
          eq(proxyHosts.dockerNodeId, nodeId),
          eq(proxyHosts.dockerContainerName, oldName)
        )
      )
      .returning();
    for (const host of updated) this.emitHost(host.id, 'updated', host.domainNames?.[0]);
    await this.additionalRoutes?.updateRenamedContainerReferences(nodeId, oldName, newName);
    this.queueDockerReconciliation();
  }

  protected async resolveStoredDockerUpstream(host: ProxyHostRow, force = false): Promise<ProxyHostRow> {
    if (!isDockerUpstream(host.upstreamKind) || !this.dockerUpstreams) return host;
    if (host.type === 'raw' || host.rawConfigEnabled) return host;
    const resolved = await this.dockerUpstreams.resolve(host, { allowPortRebind: true });
    const changed =
      host.dockerContainerPort !== resolved.dockerContainerPort ||
      host.dockerNodeId !== resolved.dockerNodeId ||
      host.dockerContainerName !== resolved.dockerContainerName ||
      host.dockerComposeProjectId !== resolved.dockerComposeProjectId ||
      host.dockerComposeServiceName !== resolved.dockerComposeServiceName ||
      host.dockerDeploymentId !== resolved.dockerDeploymentId;
    if (!changed && host.secureLinkStatus === 'active' && !force) return host;
    let updated = host;
    if (changed) {
      const [persisted] = await this.db
        .update(proxyHosts)
        .set({
          upstreamKind: resolved.upstreamKind,
          dockerNodeId: resolved.dockerNodeId,
          dockerContainerName: resolved.dockerContainerName,
          dockerComposeProjectId: resolved.dockerComposeProjectId,
          dockerComposeServiceName: resolved.dockerComposeServiceName,
          dockerDeploymentId: resolved.dockerDeploymentId,
          dockerContainerPort: resolved.dockerContainerPort,
          dockerProtocol: resolved.dockerProtocol,
          updatedAt: new Date(),
        })
        .where(eq(proxyHosts.id, host.id))
        .returning();
      updated = persisted ?? host;
    }
    return this.secureLinks ? this.secureLinks.reconcileExisting(updated) : updated;
  }

  protected async reconcileDockerUpstreams(force = false): Promise<void> {
    let retryNeeded = false;
    if (await this.secureLinks?.reconcileAdditionalLifecycle?.()) retryNeeded = true;
    if (await this.additionalRoutes?.reconcileDockerTargets(force)) retryNeeded = true;
    const pendingCleanups = await this.db.query.proxyHosts.findMany({
      where: eq(proxyHosts.secureLinkStatus, 'cleanup_pending'),
    });
    for (const host of pendingCleanups) {
      try {
        await this.secureLinks?.cleanup(host);
      } catch (error) {
        logger.debug('Secure Link cleanup is still pending', { hostId: host.id, error });
        retryNeeded = true;
      }
    }
    const hosts = await this.db.query.proxyHosts.findMany({
      where: and(
        eq(proxyHosts.type, 'proxy'),
        inArray(proxyHosts.upstreamKind, ['docker_container', 'docker_deployment']),
        ne(proxyHosts.secureLinkStatus, 'cleanup_pending')
      ),
    });
    for (const host of hosts) {
      try {
        if (host.type === 'raw' || host.rawConfigEnabled) {
          if (host.secureLinkGeneration > 0) await this.secureLinks?.cleanup(host);
          continue;
        }
        const availabilityManaged = (await this.availabilityIngressReconciler?.(host.id)) ?? false;
        if (availabilityManaged) continue;
        const updated = await this.resolveStoredDockerUpstream(host, force);
        const secureLinkChanged =
          updated.forwardHost !== host.forwardHost ||
          updated.forwardPort !== host.forwardPort ||
          updated.secureLinkGeneration !== host.secureLinkGeneration ||
          updated.secureLinkStatus !== host.secureLinkStatus ||
          updated.secureLinkListenerPort !== host.secureLinkListenerPort ||
          updated.secureLinkTargetNetwork !== host.secureLinkTargetNetwork ||
          updated.secureLinkTargetContainer !== host.secureLinkTargetContainer;
        const cutoverPending =
          updated.secureLinkGeneration > 0 &&
          (updated.secureLinkStatus === 'provisioning' ||
            updated.secureLinkStatus === 'updating' ||
            updated.secureLinkStatus === 'cutover_ready');
        if (!secureLinkChanged && !cutoverPending) continue;
        let cutoverHost = updated;
        if (updated.secureLinkGeneration > 0 && updated.secureLinkStatus !== 'active') {
          if (host.secureLinkGeneration === 0 && host.enabled) {
            await this.removeConfigFromNode(host.id, host.nodeId);
          }
          cutoverHost = (await this.secureLinks?.commitCutover(updated.id)) ?? updated;
        }
        if (cutoverHost.enabled) {
          try {
            const certPaths = await this.resolveCertPaths(cutoverHost, { preserveLegacyOnUnsupported: true });
            const accessList = await this.resolveAccessList(cutoverHost.accessListId);
            const config = await this.buildNginxConfig(cutoverHost, certPaths, accessList);
            await this.applyConfigToNode(
              cutoverHost.id,
              config,
              cutoverHost.nodeId,
              certPaths.preparedTls,
              this.configOwnershipForHost(cutoverHost),
              cutoverHost.accessListId
            );
            if (cutoverHost.secureLinkGeneration > 0) {
              await this.secureLinks?.activate(cutoverHost.id);
              this.queueSecureLinkRuntimeSample(cutoverHost);
            }
          } catch (error) {
            // Keep the newly resolved endpoint. A disconnected Nginx node will
            // receive it through the existing resync path after reconnecting.
            logger.warn('Resolved Docker upstream but could not apply Nginx config yet', {
              hostId: updated.id,
              error,
            });
            retryNeeded = true;
          }
        } else if (cutoverPending) {
          await this.secureLinks?.activate(cutoverHost.id);
          this.queueSecureLinkRuntimeSample(cutoverHost);
        }
        this.emitHost(updated.id, 'updated', updated.domainNames?.[0]);
      } catch (error) {
        // External disappearance/offline state intentionally keeps the last
        // resolved endpoint and the existing Nginx configuration intact.
        logger.debug('Keeping last resolved Docker proxy upstream', { hostId: host.id, error });
        retryNeeded = true;
      }
    }
    if (retryNeeded) this.scheduleDockerReconciliationRetry();
    else this.dockerReconcileBackoffMs = 5_000;
  }

  // -----------------------------------------------------------------------
  // Resync all hosts on a node (used on reconnect with hash mismatch)
  // -----------------------------------------------------------------------

  async resyncAllHostsOnNode(nodeId: string): Promise<void> {
    // Only resync enabled hosts explicitly assigned to this node
    const hosts = await this.db.query.proxyHosts.findMany({
      where: and(eq(proxyHosts.nodeId, nodeId), eq(proxyHosts.enabled, true)),
    });

    if (hosts.length === 0) {
      logger.info('No enabled hosts to resync for node', { nodeId });
      return;
    }

    logger.info('Resyncing all hosts on node', { nodeId, hostCount: hosts.length });
    const supportsDistribution = await this.certificateDistribution.supportsNode(nodeId);

    for (const storedHost of hosts) {
      try {
        let host = storedHost;
        try {
          host = await this.resolveStoredDockerUpstream(storedHost);
        } catch (error) {
          // A node reconnect can race the background Docker reconciler. Never
          // render the stale pre-cutover row captured above: it could restore a
          // published-IP upstream after the Secure Link was already committed.
          const current = await this.db.query.proxyHosts.findFirst({
            where: eq(proxyHosts.id, storedHost.id),
          });
          if (!current?.enabled || current.nodeId !== nodeId) continue;
          host = current;
          logger.debug('Using current proxy state after Docker resync resolution failed', {
            hostId: storedHost.id,
            error,
          });
        }
        // Existing hosts on an old daemon retain their legacy config and
        // certificate paths. A new bundle is never initiated for that fleet.
        const certPaths = await this.resolveCertPaths(host, supportsDistribution ? {} : { legacy: true });
        const accessList = await this.resolveAccessList(host.accessListId);
        const config = await this.buildNginxConfig(host, certPaths, accessList);
        await this.applyConfigToNode(
          host.id,
          config,
          host.nodeId ?? nodeId,
          certPaths.preparedTls,
          this.configOwnershipForHost(host),
          host.accessListId
        );
      } catch (err) {
        logger.error('Failed to resync host config', {
          hostId: storedHost.id,
          nodeId,
          error: (err as Error).message,
        });
      }
    }

    logger.info('Node resync complete', { nodeId, hostCount: hosts.length });
  }

  async resyncTlsHost(id: string, userId: string) {
    const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, id) });
    if (!host) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (!host.sslEnabled || !this.certificateDistribution.referenceForHost(host)) {
      throw new AppError(409, 'TLS_NOT_CONFIGURED', 'This proxy host has no TLS certificate to synchronize');
    }
    if (!host.enabled) {
      throw new AppError(
        409,
        'PROXY_HOST_DISABLED',
        'Enable the proxy host before synchronizing its TLS configuration'
      );
    }

    const certPaths = await this.resolveCertPaths(host);
    const accessList = await this.resolveAccessList(host.accessListId);
    const config = await this.buildNginxConfig(host, certPaths, accessList);
    await this.applyConfigToNode(
      host.id,
      config,
      host.nodeId,
      certPaths.preparedTls,
      this.configOwnershipForHost(host),
      host.accessListId
    );
    const distribution = await this.certificateDistribution.getStatusForHost(host);
    await this.auditService.log({
      userId,
      action: 'proxy_host.tls_resync',
      resourceType: 'proxy_host',
      resourceId: host.id,
      details: { nodeId: host.nodeId },
    });
    this.emitHost(host.id, 'tls_distribution_resynced', host.domainNames?.[0]);
    return { distribution };
  }

  async cleanupMigratedHostSource(id: string, sourceNodeId: string): Promise<{ orphanedConfigPossible: boolean }> {
    const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, id) });
    if (!host) return { orphanedConfigPossible: false };
    if (host.nodeId === sourceNodeId) {
      throw new AppError(409, 'PROXY_HOST_NOT_MIGRATED', 'Proxy host still belongs to the source Nginx node');
    }

    const connected = this.nodeDispatch.isNodeConnected(sourceNodeId);
    if (connected) {
      await this.removeConfigFromNode(id, sourceNodeId);
    }
    await this.certificateDistribution.deactivateHost(id, sourceNodeId);
    if (host.upstreamKind === 'pages') {
      await this.pageRoutes?.cleanupMigratedSource(id, sourceNodeId, connected);
    }
    await this.secureLinks?.reconcileSourceNode(sourceNodeId);
    return { orphanedConfigPossible: !connected };
  }

  // -----------------------------------------------------------------------
  // Get rendered nginx config for a host
  // -----------------------------------------------------------------------

  async getRenderedConfig(id: string): Promise<string> {
    const host = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
    });
    if (!host) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    if (host.isSystem) throw new AppError(403, 'SYSTEM_HOST', 'System proxy host config cannot be rendered here');

    const certPaths = await this.resolveCertPaths(host, { prepare: false });
    const accessList = await this.resolveAccessList(host.accessListId);
    return this.buildNginxConfig(host, certPaths, accessList);
  }

  // -----------------------------------------------------------------------
  // Internal system host management
  // -----------------------------------------------------------------------
}
