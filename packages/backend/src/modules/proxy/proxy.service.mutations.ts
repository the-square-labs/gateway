import { eq } from 'drizzle-orm';
import { proxyHosts } from '@/db/schema/index.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { AppError } from '@/middleware/error-handler.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import type { PageRouteNodeMigration } from '@/modules/pages/routes/page-route.service.js';
import type { AdditionalRouteNodeMigration } from './additional-route.service.js';
import type { CreateProxyHostInput, UpdateProxyHostInput } from './proxy.schemas.js';
import {
  assertSslPrerequisites,
  assertSslPrerequisitesForUpdate,
  normalizeProxyValidationOptions,
  type ProxyValidationInput,
  rawConfigAuditDetails,
  storedRawConfigForRawModeEnablement,
} from './proxy.service-helpers.js';
import { assertRegisteredDomainsUseNode } from './proxy-domain-node.js';
import { attachDockerUpstreamDisplay } from './proxy-upstream-display.js';

export { __testOnly } from './proxy.service-helpers.js';

import { isDockerUpstream, logger, ProxyServiceCore, sameDomainNames } from './proxy.service.core.js';

export abstract class ProxyServiceMutations extends ProxyServiceCore {
  async createProxyHost(input: CreateProxyHostInput, userId: string, validationOptions: ProxyValidationInput = {}) {
    const options = normalizeProxyValidationOptions(validationOptions);

    // 0. Require a node assignment
    if (!input.nodeId) {
      throw new AppError(400, 'NODE_REQUIRED', 'A node must be selected for the proxy host');
    }
    await assertNodeAllowsServiceCreation(this.db, input.nodeId, 'nginx');
    await assertRegisteredDomainsUseNode(this.db, input.domainNames, input.nodeId);

    // 0b. Validate advanced config if provided
    if (input.advancedConfig && !options.bypassAdvancedValidation) {
      if (/\{\{additionalSecureLinks\./.test(input.advancedConfig)) {
        throw new AppError(
          400,
          'INVALID_SECURE_LINK_REFERENCE',
          'Provision additional Secure Links after creating the proxy host'
        );
      }
      const validation = this.configGenerator.validateAdvancedConfig(input.advancedConfig);
      if (!validation.valid) {
        throw new AppError(
          400,
          'INVALID_ADVANCED_CONFIG',
          `Advanced config is invalid: ${validation.errors.join(', ')}`
        );
      }
    }
    if ((input as any).rawConfig) {
      const validation = this.configGenerator.validateAdvancedConfig(
        (input as any).rawConfig,
        true,
        options.bypassRawValidation === true
      );
      if (!validation.valid) {
        throw new AppError(400, 'INVALID_RAW_CONFIG', `Raw config is invalid: ${validation.errors.join(', ')}`);
      }
    }

    assertSslPrerequisites({
      sslEnabled: input.sslEnabled,
      sslCertificateId: input.sslCertificateId,
      internalCertificateId: input.internalCertificateId,
    });

    const upstreamData = await this.prepareCreateUpstream(input, options);
    if (input.type === 'proxy' && input.upstreamKind === 'pages') {
      await this.assertPagesTemplateCompatible(input.nginxTemplateId);
    }

    // 1. Insert into DB
    let host = await writeWithAllocatedSlug({
      source: input.domainNames[0] ?? '',
      fallback: 'proxy-host',
      reserved: ['new'],
      constraint: 'proxy_hosts_slug_unique',
      write: async (slug) => {
        const [created] = await this.db
          .insert(proxyHosts)
          .values({
            type: input.type,
            nodeId: input.nodeId,
            domainNames: input.domainNames,
            slug,
            forwardHost: input.forwardHost ?? null,
            forwardPort: input.forwardPort ?? null,
            forwardScheme: input.forwardScheme,
            ...upstreamData,
            sslEnabled: input.sslEnabled,
            sslForced: input.sslForced,
            http2Support: input.http2Support,
            websocketSupport: input.websocketSupport,
            sslCertificateId: input.sslCertificateId ?? null,
            internalCertificateId: input.internalCertificateId ?? null,
            redirectUrl: input.redirectUrl ?? null,
            redirectStatusCode: input.redirectStatusCode ?? 301,
            customHeaders: input.customHeaders,
            cacheEnabled: input.cacheEnabled,
            cacheOptions: input.cacheOptions ?? null,
            rateLimitEnabled: input.rateLimitEnabled,
            rateLimitMode: input.rateLimitMode,
            rateLimitOptions: input.rateLimitOptions ?? null,
            customRewrites: input.customRewrites,
            advancedConfig: input.advancedConfig ?? null,
            rawConfig: (input as any).rawConfig ?? null,
            rawConfigEnabled: (input as any).rawConfigEnabled ?? false,
            accessListId: input.accessListId ?? null,
            folderId: input.folderId ?? null,
            nginxTemplateId: input.nginxTemplateId ?? null,
            templateVariables: input.templateVariables ?? {},
            healthCheckEnabled: input.healthCheckEnabled,
            healthCheckUrl: input.healthCheckUrl ?? '/',
            healthCheckInterval: input.healthCheckInterval ?? 30,
            healthCheckExpectedStatus: input.healthCheckExpectedStatus ?? null,
            healthCheckExpectedBody: input.healthCheckExpectedBody ?? null,
            healthCheckBodyMatchMode: input.healthCheckBodyMatchMode ?? 'includes',
            healthStatus: input.healthCheckEnabled ? 'unknown' : 'disabled',
            createdById: userId,
          })
          .returning();
        return created;
      },
    });

    // 2. Resolve SSL cert paths and build nginx config
    try {
      if (host.upstreamKind === 'pages') {
        if (!this.pageRoutes || !input.pageProjectId || !input.pageTagId) {
          throw new AppError(503, 'PAGES_ROUTE_UNAVAILABLE', 'Pages Route service is unavailable');
        }
        await this.pageRoutes.activateNewHost(host.id, host.nodeId!, input.pageProjectId, input.pageTagId);
      } else if (isDockerUpstream(host.upstreamKind)) {
        if (!this.secureLinks) throw new Error('Proxy Secure Links are unavailable');
        host = await this.secureLinks.prepare(host, true);
        host = (await this.secureLinks.commitCutover(host.id)) ?? host;
      }
      const certPaths = await this.resolveCertPaths(host);
      const accessList = await this.resolveAccessList(host.accessListId);
      const config = await this.buildNginxConfig(host, certPaths, accessList);

      // 3. Apply config via daemon or legacy docker
      await this.applyConfigToNode(
        host.id,
        config,
        host.nodeId,
        certPaths.preparedTls,
        this.configOwnershipForHost(host),
        host.accessListId
      );
      if (isDockerUpstream(host.upstreamKind)) {
        await this.secureLinks?.activate(host.id);
        this.queueSecureLinkRuntimeSample(host);
      }
    } catch (error) {
      // 4. If nginx fails, delete the DB row and throw
      logger.error('Failed to apply nginx config for new proxy host, rolling back DB insert', {
        hostId: host.id,
        error,
      });
      // Applying a config can fail after nginx-daemon has already persisted the
      // file (for example while the relay policy is being committed). Remove
      // that partial deployment before deleting the row or a stale server_name
      // can shadow the next successful create for the same domain.
      await this.removeConfigFromNode(host.id, host.nodeId).catch((cleanupError) => {
        logger.warn('Failed to remove partially applied proxy config after create rollback', {
          hostId: host.id,
          cleanupError,
        });
      });
      await this.secureLinks?.cleanup(host).catch((cleanupError) => {
        logger.warn('Failed to cleanup secure link after proxy create rollback', { hostId: host.id, cleanupError });
      });
      let preservePageRouteOwnership = false;
      if (host.upstreamKind === 'pages') {
        try {
          // activateNewHost can return after its own best-effort marker write
          // failed. Persist the failed-create claim before attempting another
          // daemon cleanup so reconciliation never infers ownership from a
          // generic staging row.
          await this.pageRoutes?.claimFailedCreateCleanup(host.id);
          await this.pageRoutes?.removeHost(host.id, host.nodeId);
        } catch (cleanupError) {
          preservePageRouteOwnership = true;
          logger.warn('Preserving Pages Route ownership after proxy create rollback cleanup failure', {
            hostId: host.id,
            cleanupError,
          });
          await this.disablePageHostForDeferredCleanup(host.id, cleanupError);
        }
      }
      if (!preservePageRouteOwnership) {
        try {
          await this.db.delete(proxyHosts).where(eq(proxyHosts.id, host.id));
        } catch (deleteError) {
          if (host.upstreamKind !== 'pages') throw deleteError;
          preservePageRouteOwnership = true;
          await this.disablePageHostForDeferredCleanup(host.id, deleteError);
        }
      }
      if (error instanceof AppError) throw error;
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to apply Nginx config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    // 5. Audit log
    await this.auditService.log({
      userId,
      action: 'proxy_host.create',
      resourceType: 'proxy_host',
      resourceId: host.id,
      details: { type: host.type, domainNames: host.domainNames, ...rawConfigAuditDetails(input, options) },
    });

    logger.info('Created proxy host', { hostId: host.id, domains: host.domainNames });
    this.emitHost(host.id, 'created', host.domainNames?.[0]);

    // 6. Fire-and-forget immediate health check
    if (host.healthCheckEnabled) {
      this.runImmediateHealthCheck(host.id);
    }

    // 7. Return created host
    return (await attachDockerUpstreamDisplay(this.db, [host]))[0]!;
  }

  // -----------------------------------------------------------------------
  // Update
  // -----------------------------------------------------------------------

  async updateProxyHost(
    id: string,
    input: UpdateProxyHostInput,
    userId: string,
    validationOptions: ProxyValidationInput = {}
  ) {
    const options = normalizeProxyValidationOptions(validationOptions);

    // 0. Validate advanced config if provided
    if (input.advancedConfig && !options.bypassAdvancedValidation) {
      const validation = this.configGenerator.validateAdvancedConfig(input.advancedConfig);
      if (!validation.valid) {
        throw new AppError(
          400,
          'INVALID_ADVANCED_CONFIG',
          `Advanced config is invalid: ${validation.errors.join(', ')}`
        );
      }
    }
    if ((input as any).rawConfig) {
      const validation = this.configGenerator.validateAdvancedConfig(
        (input as any).rawConfig,
        true,
        options.bypassRawValidation === true
      );
      if (!validation.valid) {
        throw new AppError(400, 'INVALID_RAW_CONFIG', `Raw config is invalid: ${validation.errors.join(', ')}`);
      }
    }

    // 1. Get existing host
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.id, id),
    });
    if (!existing) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    const effectiveRelaySpreadMode = input.relaySpreadMode ?? existing.relaySpreadMode;
    const effectiveRelaySpreadCount =
      input.relaySpreadMode !== undefined && input.relaySpreadMode !== 'fixed'
        ? null
        : input.relaySpreadCount !== undefined
          ? input.relaySpreadCount
          : existing.relaySpreadCount;
    if (effectiveRelaySpreadMode === 'fixed' && effectiveRelaySpreadCount == null) {
      throw new AppError(400, 'RELAY_SPREAD_COUNT_REQUIRED', 'Relay spread count is required in fixed mode');
    }
    if (effectiveRelaySpreadMode !== 'fixed' && effectiveRelaySpreadCount != null) {
      throw new AppError(400, 'RELAY_SPREAD_COUNT_INVALID', 'Relay spread count is only available in fixed mode');
    }
    await this.additionalRoutes?.assertHostTemplateMutationAllowed(
      existing,
      input as unknown as Record<string, unknown>
    );
    if (existing.upstreamKind === 'pages' && (input.type === 'redirect' || input.type === '404')) {
      throw new AppError(
        409,
        'PAGES_ROUTE_TYPE_CHANGE_UNSUPPORTED',
        'Recreate the Route to change its Pages target type'
      );
    }
    if (existing.upstreamKind === 'pages' && (input.type === 'raw' || input.rawConfigEnabled === true)) {
      throw new AppError(400, 'PAGES_ROUTE_SETTINGS_INVALID', 'Pages Routes do not support Raw Config mode');
    }
    if (existing.upstreamKind === 'pages' && input.nginxTemplateId !== undefined) {
      await this.assertPagesTemplateCompatible(input.nginxTemplateId);
    }
    if (existing.upstreamKind === 'pages' && input.websocketSupport === true) {
      throw new AppError(
        400,
        'PAGES_ROUTE_SETTINGS_INVALID',
        'WebSocket upgrades are not available for static Pages Routes'
      );
    }
    if (existing.isSystem && !(options.allowSystemNodeMove && Object.keys(input).every((key) => key === 'nodeId'))) {
      throw new AppError(403, 'SYSTEM_HOST', 'System proxy hosts cannot be edited');
    }
    if (input.advancedConfig !== undefined) {
      await this.secureLinks?.assertAdditionalReferences(existing.id, input.advancedConfig);
    }
    if (
      existing.maintenanceEnabled &&
      ((input.type !== undefined && input.type !== 'proxy') || input.rawConfigEnabled === true)
    ) {
      throw new AppError(
        409,
        'MAINTENANCE_MODE_CONFLICT',
        'Exit maintenance mode before changing the host type or enabling raw config'
      );
    }

    const storedRawConfig = storedRawConfigForRawModeEnablement(existing, input);
    if (storedRawConfig) {
      const validation = this.configGenerator.validateAdvancedConfig(
        storedRawConfig as string,
        true,
        options.bypassRawValidation === true
      );
      if (!validation.valid) {
        throw new AppError(400, 'INVALID_RAW_CONFIG', `Raw config is invalid: ${validation.errors.join(', ')}`);
      }
    }

    if (input.nodeId && input.nodeId !== existing.nodeId) {
      if ((await this.secureLinks?.listAdditional(existing.id))?.length) {
        throw new AppError(
          409,
          'ADDITIONAL_SECURE_LINK_NODE_MOVE_BLOCKED',
          'Remove additional Secure Link bindings before moving this proxy host to another node'
        );
      }
      await assertNodeAllowsServiceCreation(this.db, input.nodeId, 'nginx');
    }
    const effectiveNodeId = input.nodeId ?? existing.nodeId;
    if (!effectiveNodeId) throw new AppError(400, 'NODE_REQUIRED', 'A node must be selected for the proxy host');
    const domainAssignmentChanged =
      (input.nodeId !== undefined && input.nodeId !== existing.nodeId) ||
      (input.domainNames !== undefined && !sameDomainNames(input.domainNames, existing.domainNames));
    if (domainAssignmentChanged && !options.skipDomainNodeValidation) {
      await assertRegisteredDomainsUseNode(this.db, input.domainNames ?? existing.domainNames, effectiveNodeId);
    }

    assertSslPrerequisitesForUpdate(existing, input);

    const upstreamData = await this.prepareUpdateUpstream(existing, input, options);
    let pageNodeMigration: PageRouteNodeMigration | null = null;
    let additionalRouteMigration: AdditionalRouteNodeMigration | null = null;

    // 2. Update DB
    const { pageProjectId, pageTagId, ...proxyInput } = input;
    const updateData: Record<string, unknown> = {
      ...proxyInput,
      ...upstreamData,
      ...(input.relaySpreadMode !== undefined && input.relaySpreadMode !== 'fixed' ? { relaySpreadCount: null } : {}),
      updatedAt: new Date(),
    };

    // Raw mode bypasses managed upstream settings, so managed health checks are not meaningful.
    const enablesRawMode = input.rawConfigEnabled === true || input.type === 'raw';
    if (enablesRawMode) {
      updateData.healthCheckEnabled = false;
      updateData.healthStatus = 'disabled';
    }

    // Update healthStatus when healthCheckEnabled changes
    if (!enablesRawMode && input.healthCheckEnabled !== undefined) {
      if (!input.healthCheckEnabled) {
        updateData.healthStatus = 'disabled';
      } else if (!existing.healthCheckEnabled) {
        // Was disabled, now enabled — set to unknown until first check
        updateData.healthStatus = 'unknown';
      }
    }

    const updateHost = async (slug?: string) => {
      const [updated] = await this.db
        .update(proxyHosts)
        .set({ ...updateData, ...(slug === undefined ? {} : { slug }) })
        .where(eq(proxyHosts.id, id))
        .returning();
      return updated;
    };
    const primaryDomainChanged = input.domainNames !== undefined && input.domainNames[0] !== existing.domainNames[0];
    let updated = primaryDomainChanged
      ? await writeWithAllocatedSlug({
          source: input.domainNames?.[0] ?? '',
          fallback: 'proxy-host',
          reserved: ['new'],
          constraint: 'proxy_hosts_slug_unique',
          write: updateHost,
        })
      : await updateHost();

    // The UI can submit a complete form on an unrelated edit. Gate old
    // daemons on an actual TLS or placement change, not on field presence,
    // so existing HTTPS hosts remain editable during a mixed-fleet rollout.
    const tlsReferenceChanged =
      updated.sslEnabled !== existing.sslEnabled ||
      updated.sslCertificateId !== existing.sslCertificateId ||
      updated.internalCertificateId !== existing.internalCertificateId ||
      updated.nodeId !== existing.nodeId;
    const nodeChanged = updated.nodeId !== existing.nodeId;
    const existingUsesRawMode = existing.type === 'raw' || existing.rawConfigEnabled;
    const updatedUsesRawMode = updated.type === 'raw' || updated.rawConfigEnabled;
    const formerDockerNodeId =
      isDockerUpstream(existing.upstreamKind) &&
      isDockerUpstream(updated.upstreamKind) &&
      existing.dockerNodeId &&
      updated.dockerNodeId !== existing.dockerNodeId
        ? existing.dockerNodeId
        : null;
    let appliedOnTargetNode = false;

    // 3. Regenerate nginx config
    try {
      if (existing.upstreamKind === 'pages' && updated.nodeId !== existing.nodeId && options.allowPagesNodeMove) {
        if (!existing.nodeId || !updated.nodeId || !this.pageRoutes) {
          throw new AppError(503, 'PAGES_ROUTE_UNAVAILABLE', 'Pages Route migration is unavailable');
        }
        pageNodeMigration = await this.pageRoutes.stageNodeMigration(existing.id, existing.nodeId, updated.nodeId);
      }
      if (nodeChanged && updated.enabled && existing.nodeId && updated.nodeId && this.additionalRoutes) {
        additionalRouteMigration = await this.additionalRoutes.stageNodeMigration(
          existing.id,
          existing.nodeId,
          updated.nodeId
        );
      }
      if (isDockerUpstream(updated.upstreamKind) && !updatedUsesRawMode) {
        if (!this.secureLinks) throw new Error('Proxy Secure Links are unavailable');
        const requiresSecureLink =
          existing.upstreamKind === 'manual' ||
          existingUsesRawMode ||
          (existing.secureLinkGeneration < 1 && Object.keys(upstreamData).length > 0);
        updated = await this.secureLinks.prepare(updated, requiresSecureLink, nodeChanged);
        if (updated.secureLinkGeneration > 0 && updated.secureLinkStatus !== 'active') {
          // Existing legacy/manual config must stop serving before the durable
          // no-fallback cutover marker is committed.
          if (existing.secureLinkGeneration === 0 && existing.enabled) {
            await this.removeConfigFromNode(id, existing.nodeId);
          }
          updated = (await this.secureLinks.commitCutover(id)) ?? updated;
        }
      }
      if (updated.enabled) {
        const certPaths = await this.resolveCertPaths(updated, {
          preserveLegacyOnUnsupported: existing.sslEnabled && !tlsReferenceChanged,
        });
        const accessList = await this.resolveAccessList(updated.accessListId);
        const config = await this.buildNginxConfig(
          updated,
          certPaths,
          accessList,
          pageNodeMigration?.targetIncludePath
        );
        // 4. Apply config with rollback on failure
        await this.applyConfigToNode(
          id,
          config,
          updated.nodeId,
          certPaths.preparedTls,
          this.configOwnershipForHost(updated),
          updated.accessListId
        );
        if (isDockerUpstream(updated.upstreamKind) && !updatedUsesRawMode) {
          await this.secureLinks?.activate(id);
          this.queueSecureLinkRuntimeSample(updated);
        }
        appliedOnTargetNode = true;

        // The new target is now known-good. Only then retire the former
        // node's config and begin its certificate replica grace period.
        if (nodeChanged && existing.enabled && !options.preserveFormerNodeConfig) {
          await this.removeConfigFromNode(id, existing.nodeId);
          await this.certificateDistribution.deactivateHost(id, existing.nodeId);
        }
      } else {
        // If disabled, remove config and reload
        const deployedNodeId = nodeChanged ? existing.nodeId : updated.nodeId;
        await this.removeConfigFromNode(id, deployedNodeId);
        await this.certificateDistribution.deactivateHost(id, deployedNodeId);
      }
      if (updated.upstreamKind === 'pages' && (pageProjectId || pageTagId)) {
        if (!this.pageRoutes || !pageProjectId || !pageTagId) {
          throw new AppError(400, 'PAGES_ROUTE_TARGET_REQUIRED', 'Select both a Page Project and Tag');
        }
        await this.pageRoutes.retarget(id, pageProjectId, pageTagId, userId);
      }
      const leavesManagedDocker =
        isDockerUpstream(existing.upstreamKind) && (updated.upstreamKind === 'manual' || updatedUsesRawMode);
      if (leavesManagedDocker && existing.secureLinkGeneration > 0) {
        try {
          await this.secureLinks?.cleanup(existing);
        } catch (cleanupError) {
          // The manual/raw config is already committed. Keep it active and
          // retry the independent Secure Link teardown.
          logger.warn('Proxy left managed Docker mode; Secure Link cleanup will retry', {
            hostId: id,
            cleanupError,
          });
          this.queueDockerReconciliation();
        }
      }
      if (formerDockerNodeId) await this.secureLinks?.reconcileTargetNode(formerDockerNodeId);
      if (pageNodeMigration) await this.pageRoutes?.commitNodeMigration(pageNodeMigration);
      if (additionalRouteMigration) await this.additionalRoutes?.commitNodeMigration(additionalRouteMigration);
    } catch (error) {
      let failure = error;
      if (additionalRouteMigration) {
        try {
          await this.additionalRoutes?.rollbackNodeMigration(additionalRouteMigration);
        } catch (rollbackError) {
          logger.error('Failed to rollback Additional Route node migration', {
            hostId: id,
            migration: additionalRouteMigration,
            rollbackError,
          });
          failure = new AppError(
            500,
            'ADDITIONAL_ROUTE_MIGRATION_ROLLBACK_FAILED',
            'Additional Route migration rollback failed'
          );
        }
      }
      if (pageNodeMigration) {
        try {
          await this.pageRoutes?.rollbackNodeMigration(pageNodeMigration);
        } catch (rollbackError) {
          logger.error('Failed to rollback Pages Route node migration', {
            hostId: id,
            migration: pageNodeMigration,
            rollbackError,
          });
          failure = new AppError(500, 'PAGES_ROUTE_MIGRATION_ROLLBACK_FAILED', 'Pages Route migration rollback failed');
        }
      }
      const currentSecureState = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, id) });
      const mustRollForwardSecureLink =
        currentSecureState?.secureLinkMigratedAt != null &&
        (currentSecureState.secureLinkStatus === 'provisioning' ||
          currentSecureState.secureLinkStatus === 'updating' ||
          currentSecureState.secureLinkStatus === 'cutover_ready');
      if (mustRollForwardSecureLink) {
        await this.secureLinks?.markCutoverError(id, failure).catch(() => undefined);
        this.queueDockerReconciliation();
        if (failure instanceof AppError) throw failure;
        throw new AppError(
          500,
          'NGINX_CONFIG_FAILED',
          `Secure Link cutover will retry: ${failure instanceof Error ? failure.message : 'unknown error'}`
        );
      }
      if (nodeChanged && appliedOnTargetNode) {
        try {
          await this.removeConfigFromNode(id, updated.nodeId);
          await this.certificateDistribution.deactivateHost(id, updated.nodeId);
        } catch (cleanupError) {
          logger.warn('Failed to remove new-node config after proxy host move rollback', {
            hostId: id,
            nodeId: updated.nodeId,
            cleanupError,
          });
        }
        if (existing.enabled) {
          try {
            await this.restoreConfigOnNode(existing);
          } catch (restoreError) {
            logger.error('Failed to restore former-node config after proxy host move rollback', {
              hostId: id,
              nodeId: existing.nodeId,
              restoreError,
            });
          }
        }
      }
      // Roll back every field changed by the request or by upstream resolution.
      logger.error('Failed to apply nginx config during update, rolling back DB', {
        hostId: id,
        error: failure,
      });
      const rollbackData: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(proxyInput), ...Object.keys(upstreamData)])) {
        rollbackData[key] = (existing as Record<string, unknown>)[key];
      }
      if (primaryDomainChanged) rollbackData.slug = existing.slug;
      if (isDockerUpstream(existing.upstreamKind) || isDockerUpstream(updated.upstreamKind)) {
        for (const key of [
          'forwardHost',
          'forwardPort',
          'dockerHostPort',
          'secureLinkGeneration',
          'secureLinkStatus',
          'secureLinkLastError',
          'secureLinkTargetNetwork',
          'secureLinkTargetContainer',
          'secureLinkTargetHost',
          'secureLinkListenerPort',
          'secureLinkConnectorPort',
          'secureLinkMigratedAt',
        ] as const) {
          rollbackData[key] = existing[key];
        }
      }
      const rollbackSecureLinkGeneration =
        existing.secureLinkGeneration > 0
          ? Math.max(existing.secureLinkGeneration, updated.secureLinkGeneration) + 1
          : existing.secureLinkGeneration;
      rollbackData.secureLinkGeneration = rollbackSecureLinkGeneration;
      rollbackData.updatedAt = existing.updatedAt;
      try {
        await this.db.update(proxyHosts).set(rollbackData).where(eq(proxyHosts.id, id));
        if (updated.secureLinkGeneration > 0 && existing.secureLinkGeneration === 0) {
          await this.secureLinks?.cleanup(updated);
        } else if (existing.secureLinkGeneration > 0) {
          await this.secureLinks?.reconcileExisting({
            ...existing,
            secureLinkGeneration: rollbackSecureLinkGeneration,
          });
          if (formerDockerNodeId && updated.dockerNodeId) {
            await this.secureLinks?.reconcileTargetNode(updated.dockerNodeId);
          }
        }
      } catch (rollbackError) {
        logger.error('Failed to rollback DB after nginx config failure', {
          hostId: id,
          rollbackError,
        });
      }
      if (failure instanceof AppError) throw failure;
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to apply Nginx config: ${failure instanceof Error ? failure.message : 'unknown error'}`
      );
    }

    // 5. Audit log
    await this.auditService.log({
      userId,
      action: 'proxy_host.update',
      resourceType: 'proxy_host',
      resourceId: id,
      details: { changes: Object.keys(input), ...rawConfigAuditDetails(input, options) },
    });

    logger.info('Updated proxy host', { hostId: id });
    this.emitHost(
      id,
      'updated',
      updated.domainNames?.[0],
      updated.slug === existing.slug ? {} : { oldSlug: existing.slug, slug: updated.slug }
    );

    // Fire immediate health check if healthcheck was just enabled
    if (input.healthCheckEnabled && !existing.healthCheckEnabled && updated.enabled) {
      this.runImmediateHealthCheck(id);
    }

    if (
      updated.relaySpreadMode !== existing.relaySpreadMode ||
      updated.relaySpreadCount !== existing.relaySpreadCount
    ) {
      await this.relayPool?.stageProxyWorkloadRebalance(id, userId).catch((error) => {
        logger.warn('Failed to stage Relay Pool redistribution after workload spread update', {
          hostId: id,
          error,
        });
      });
    }

    return (await attachDockerUpstreamDisplay(this.db, [updated]))[0]!;
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------
}
