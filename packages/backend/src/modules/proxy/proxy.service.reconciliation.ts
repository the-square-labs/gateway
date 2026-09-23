import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { domains, nodes, proxyAdditionalRoutes, proxyAdditionalSecureLinks, proxyHosts } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { runImmediateProxyHealthCheck } from './proxy-health-check.js';
import { proxyHostLockKey, proxyNodeLockKey, withProxyHostLock, withProxyLocks } from './proxy-host-lock.js';

export { __testOnly } from './proxy.service-helpers.js';

import { isDockerUpstream, logger, type ProxyHostRow } from './proxy.service.core.js';
import { ProxyServiceListing } from './proxy.service.listing.js';

interface AppliedNodeHostConfig {
  config: string;
  configOwnership: string;
  epoch: number;
}

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
      await this.reapplyHostConfig(host.id);
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
    const updated = await this.db.transaction(async (tx) => {
      const hosts = await tx
        .update(proxyHosts)
        .set({
          dockerContainerName: newName,
          secureLinkTargetContainer: sql`case
            when ${proxyHosts.secureLinkTargetContainer} = ${oldName} then ${newName}
            else ${proxyHosts.secureLinkTargetContainer}
          end`,
          // An active primary link needs a new relay/daemon generation after
          // its container name changes. Keeping this durable state makes a
          // failed immediate reconciliation recoverable after restart.
          secureLinkStatus: sql`case
            when ${proxyHosts.secureLinkGeneration} > 0 and ${proxyHosts.secureLinkStatus} = 'active' then 'updating'
            else ${proxyHosts.secureLinkStatus}
          end`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(proxyHosts.upstreamKind, 'docker_container'),
            eq(proxyHosts.dockerNodeId, nodeId),
            eq(proxyHosts.dockerContainerName, oldName)
          )
        )
        .returning();

      await tx
        .update(proxyAdditionalRoutes)
        .set({ dockerContainerName: newName, updatedAt: new Date() })
        .where(
          and(
            eq(proxyAdditionalRoutes.targetKind, 'docker_container'),
            eq(proxyAdditionalRoutes.dockerNodeId, nodeId),
            eq(proxyAdditionalRoutes.dockerContainerName, oldName)
          )
        );

      await tx
        .update(proxyAdditionalSecureLinks)
        .set({
          dockerContainerName: newName,
          targetContainer: sql`case
            when ${proxyAdditionalSecureLinks.targetContainer} = ${oldName} then ${newName}
            else ${proxyAdditionalSecureLinks.targetContainer}
          end`,
          generation: sql`${proxyAdditionalSecureLinks.generation} + 1`,
          status: 'provisioning',
          lastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(proxyAdditionalSecureLinks.upstreamKind, 'docker_container'),
            eq(proxyAdditionalSecureLinks.dockerNodeId, nodeId),
            eq(proxyAdditionalSecureLinks.dockerContainerName, oldName),
            ne(proxyAdditionalSecureLinks.status, 'cleanup_pending')
          )
        );
      return hosts;
    });
    for (const host of updated) this.emitHost(host.id, 'updated', host.domainNames?.[0]);
    this.queueDockerReconciliation(true);
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
      host.dockerDeploymentId !== resolved.dockerDeploymentId ||
      (host.secureLinkGeneration > 0 && host.secureLinkTargetContainer !== resolved.dockerContainerName);
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
    for (const listedHost of hosts) {
      try {
        const reconciled = await withProxyHostLock(listedHost.id, async () => {
          // Re-read under the host lock: an edit that finished after the batch
          // query must never be overwritten with the stale listed row.
          const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, listedHost.id) });
          if (
            !host ||
            host.type !== 'proxy' ||
            !isDockerUpstream(host.upstreamKind) ||
            host.secureLinkStatus === 'cleanup_pending'
          ) {
            return true;
          }
          if (host.rawConfigEnabled) {
            if (host.secureLinkGeneration > 0) await this.secureLinks?.cleanup(host);
            return true;
          }
          const availabilityManaged = (await this.availabilityIngressReconciler?.(host.id)) ?? false;
          if (availabilityManaged) return true;
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
          if (!secureLinkChanged && !cutoverPending) return true;
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
              this.emitHost(updated.id, 'updated', updated.domainNames?.[0]);
              return false;
            }
          } else if (cutoverPending) {
            await this.secureLinks?.activate(cutoverHost.id);
            this.queueSecureLinkRuntimeSample(cutoverHost);
          }
          this.emitHost(updated.id, 'updated', updated.domainNames?.[0]);
          return true;
        });
        if (!reconciled) retryNeeded = true;
      } catch (error) {
        // External disappearance/offline state intentionally keeps the last
        // resolved endpoint and the existing Nginx configuration intact.
        logger.debug('Keeping last resolved Docker proxy upstream', { hostId: listedHost.id, error });
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

    logger.info('Resyncing all hosts on node', { nodeId, hostCount: hosts.length });
    const supportsDistribution = hosts.length > 0 ? await this.certificateDistribution.supportsNode(nodeId) : false;
    const applied = new Map<string, AppliedNodeHostConfig>();
    let failures = 0;

    for (const storedHost of hosts) {
      try {
        const result = await withProxyHostLock(storedHost.id, async () => {
          // Re-read under the host lock so an edit that committed after the
          // batch query is never overwritten with the stale listed row.
          const current = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, storedHost.id) });
          if (!current?.enabled || current.nodeId !== nodeId) return null;
          let host = current;
          try {
            host = await this.resolveStoredDockerUpstream(current);
          } catch (error) {
            // A node reconnect can race the background Docker reconciler. Never
            // render the stale pre-cutover row: it could restore a published-IP
            // upstream after the Secure Link was already committed.
            const latest = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, storedHost.id) });
            if (!latest?.enabled || latest.nodeId !== nodeId) return null;
            host = latest;
            logger.debug('Using current proxy state after Docker resync resolution failed', {
              hostId: storedHost.id,
              error,
            });
          }
          // Existing hosts on an old daemon retain their legacy config and
          // certificate paths. A new bundle is never initiated for that fleet.
          return this.renderAndApplyHost(host, supportsDistribution ? {} : { legacy: true });
        });
        if (result) applied.set(storedHost.id, result);
      } catch (err) {
        failures += 1;
        logger.error('Failed to resync host config', {
          hostId: storedHost.id,
          nodeId,
          error: (err as Error).message,
        });
      }
    }

    logger.info('Node resync complete', { nodeId, hostCount: hosts.length, failures });
    try {
      await this.removeStaleConfigsOnNode(nodeId, applied, failures);
    } catch (error) {
      logger.warn('Stale proxy config cleanup failed after node resync', {
        nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Remove proxy-host configs that no longer belong to an enabled host on this
   * node (for example a host deleted or moved while the node was unreachable).
   *
   * The daemon has no listing command, but every nginx-daemon version supports
   * FullSync, which rewrites the given host configs and deletes any other
   * `proxy-host-*.conf`. It is sent only with the exact configs that this
   * resync just applied, so it never changes a live host and never touches
   * Pages, maintenance or other non-proxy-host files. Cleanup is skipped
   * whenever that cannot be guaranteed: a host failed to resync, another write
   * raced the resync, or an ingress migration still keeps this node serving
   * its former routes until DNS moves.
   */
  protected async removeStaleConfigsOnNode(
    nodeId: string,
    applied: Map<string, AppliedNodeHostConfig>,
    failures: number
  ): Promise<void> {
    if (failures > 0) {
      logger.warn('Skipping stale proxy config cleanup: not every host resynced', { nodeId, failures });
      return;
    }
    if (!this.nodeDispatch.isNodeConnected(nodeId)) return;
    const [node] = await this.db
      .select({ type: nodes.type, configVersionHash: nodes.configVersionHash })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (node?.type !== 'nginx') return;
    const [migration] = await this.db
      .select({ id: domains.id })
      .from(domains)
      .where(eq(domains.ingressMigrationSourceNodeId, nodeId))
      .limit(1);
    if (migration) {
      logger.info('Skipping stale proxy config cleanup during ingress migration', { nodeId });
      return;
    }

    await withProxyLocks([...[...applied.keys()].map(proxyHostLockKey), proxyNodeLockKey(nodeId)], async () => {
      const current = await this.db.query.proxyHosts.findMany({
        where: and(eq(proxyHosts.nodeId, nodeId), eq(proxyHosts.enabled, true)),
        columns: { id: true },
      });
      const unchanged =
        current.length === applied.size &&
        current.every((host) => {
          const entry = applied.get(host.id);
          return entry !== undefined && (this.hostConfigEpochs.get(host.id) ?? 0) === entry.epoch;
        });
      if (!unchanged) {
        logger.info('Skipping stale proxy config cleanup: hosts changed during resync', { nodeId });
        return;
      }
      const result = await this.nodeDispatch.fullSync(
        nodeId,
        [...applied].map(([hostId, entry]) => ({
          hostId,
          configContent: entry.config,
          configOwnership: entry.configOwnership,
        })),
        [],
        '',
        [],
        node.configVersionHash ?? ''
      );
      if (!result.success) {
        logger.warn('Stale proxy config cleanup was rejected by the node', { nodeId, error: result.error });
        return;
      }
      logger.info('Removed stale proxy configs after node resync', { nodeId, hostCount: applied.size });
    });
  }

  async resyncTlsHost(id: string, userId: string) {
    return withProxyHostLock(id, () => this.resyncTlsHostLocked(id, userId));
  }

  private async resyncTlsHostLocked(id: string, userId: string) {
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
