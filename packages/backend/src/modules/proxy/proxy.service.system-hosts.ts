import { eq } from 'drizzle-orm';
import { proxyHosts } from '@/db/schema/index.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  INTERNAL_REGISTRY_INGRESS_ID,
  INTERNAL_REGISTRY_INGRESS_PORT,
} from '@/modules/docker/docker-registry.constants.js';
import { assertNodeAllowsServiceCreation } from '@/modules/nodes/service-creation-lock.js';
import { buildStatusPageSystemHostRollbackData, getStatusPageUpstream } from './proxy.service-helpers.js';
import { clearDockerUpstreamFields } from './proxy-docker-upstream.service.js';

export { __testOnly } from './proxy.service-helpers.js';

import {
  logger,
  type ProxyHostRow,
  type RegistrySystemHostInput,
  type StatusPageSystemHostInput,
} from './proxy.service.core.js';
import { ProxyServiceReconciliation } from './proxy.service.reconciliation.js';

export class ProxyServiceSystemHosts extends ProxyServiceReconciliation {
  async upsertStatusPageSystemHost(input: StatusPageSystemHostInput, userId: string): Promise<ProxyHostRow> {
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.systemKind, 'status_page'),
    });
    if (!existing || existing.nodeId !== input.nodeId) {
      await assertNodeAllowsServiceCreation(this.db, input.nodeId, 'nginx');
    }
    const sslEnabled = !!input.sslCertificateId;
    const upstream = getStatusPageUpstream(input.upstreamUrl);
    const data = {
      type: 'proxy' as const,
      domainNames: [input.domain],
      enabled: true,
      forwardHost: upstream.host,
      forwardPort: upstream.port,
      forwardScheme: upstream.scheme,
      sslEnabled,
      sslForced: sslEnabled,
      http2Support: true,
      websocketSupport: false,
      sslCertificateId: input.sslCertificateId ?? null,
      internalCertificateId: null,
      redirectUrl: null,
      redirectStatusCode: 301,
      customHeaders: [],
      cacheEnabled: false,
      cacheOptions: null,
      rateLimitEnabled: false,
      rateLimitOptions: null,
      customRewrites: [],
      advancedConfig: null,
      rawConfig: null,
      rawConfigEnabled: false,
      accessListId: null,
      folderId: null,
      nginxTemplateId: input.nginxTemplateId ?? null,
      templateVariables: {},
      nodeId: input.nodeId,
      healthCheckEnabled: false,
      healthCheckUrl: '/',
      healthCheckInterval: 30,
      healthCheckExpectedStatus: null,
      healthCheckExpectedBody: null,
      healthCheckBodyMatchMode: 'includes' as const,
      healthCheckSlowThreshold: 3,
      healthStatus: 'disabled' as const,
      isSystem: true,
      systemKind: 'status_page',
      updatedAt: new Date(),
    };

    const createdNew = !existing;
    const writeHost = async (slug?: string) => {
      const [host] = existing
        ? await this.db
            .update(proxyHosts)
            .set({ ...data, ...(slug === undefined ? {} : { slug }) })
            .where(eq(proxyHosts.id, existing.id))
            .returning()
        : await this.db
            .insert(proxyHosts)
            .values({
              ...data,
              slug: slug!,
              createdById: userId,
            })
            .returning();
      return host;
    };
    const primaryDomainChanged = !existing || existing.domainNames[0] !== input.domain;
    const host = primaryDomainChanged
      ? await writeWithAllocatedSlug({
          source: input.domain,
          fallback: 'proxy-host',
          reserved: ['new'],
          constraint: 'proxy_hosts_slug_unique',
          write: writeHost,
        })
      : await writeHost();

    try {
      const certPaths = await this.resolveCertPaths(host);
      const config = await this.buildNginxConfig(host, certPaths, null);
      await this.applyConfigToNode(
        host.id,
        config,
        host.nodeId,
        certPaths.preparedTls,
        this.configOwnershipForHost(host)
      );
    } catch (error) {
      logger.error('Failed to apply status page system proxy host config', {
        hostId: host.id,
        error,
      });
      if (createdNew) {
        await this.db.delete(proxyHosts).where(eq(proxyHosts.id, host.id));
      } else if (existing) {
        await this.db
          .update(proxyHosts)
          .set({ ...buildStatusPageSystemHostRollbackData(existing), slug: existing.slug } as any)
          .where(eq(proxyHosts.id, existing.id));
      }
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to apply status page proxy config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    await this.auditService.log({
      userId,
      action: existing ? 'proxy_host.system_update' : 'proxy_host.system_create',
      resourceType: 'proxy_host',
      resourceId: host.id,
      details: { systemKind: 'status_page', domain: input.domain, nodeId: input.nodeId },
    });
    this.emitHost(host.id, 'updated', input.domain);
    return host;
  }

  async disableStatusPageSystemHost(userId: string): Promise<ProxyHostRow | null> {
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.systemKind, 'status_page'),
    });
    if (!existing) return null;

    try {
      await this.removeConfigFromNode(existing.id, existing.nodeId);
      await this.certificateDistribution.deactivateHost(existing.id, existing.nodeId);
      await this.db.delete(proxyHosts).where(eq(proxyHosts.id, existing.id));
    } catch (error) {
      logger.error('Failed to remove status page system proxy host config', {
        hostId: existing.id,
        error,
      });
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to disable status page proxy config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    await this.auditService.log({
      userId,
      action: 'proxy_host.system_disable',
      resourceType: 'proxy_host',
      resourceId: existing.id,
      details: { systemKind: 'status_page' },
    });
    this.emitHost(existing.id, 'deleted', existing.domainNames?.[0]);
    return existing;
  }

  async upsertRegistrySystemHost(input: RegistrySystemHostInput, userId: string | null): Promise<ProxyHostRow> {
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.systemKind, 'docker_registry'),
    });
    if (!existing || existing.nodeId !== input.nodeId) {
      await assertNodeAllowsServiceCreation(this.db, input.nodeId, 'nginx');
    }
    const data = {
      type: 'proxy' as const,
      domainNames: [input.domain],
      enabled: true,
      upstreamKind: 'manual' as const,
      forwardHost: '127.0.0.1',
      forwardPort: INTERNAL_REGISTRY_INGRESS_PORT,
      forwardScheme: 'http' as const,
      ...clearDockerUpstreamFields(),
      sslEnabled: true,
      sslForced: true,
      http2Support: true,
      websocketSupport: false,
      sslCertificateId: input.sslCertificateId,
      internalCertificateId: null,
      redirectUrl: null,
      redirectStatusCode: 301,
      customHeaders: [],
      cacheEnabled: false,
      cacheOptions: null,
      rateLimitEnabled: false,
      rateLimitOptions: null,
      customRewrites: [],
      advancedConfig: ['client_max_body_size 0;', 'proxy_request_buffering off;', 'proxy_buffering off;'].join('\n'),
      rawConfig: null,
      rawConfigEnabled: false,
      accessListId: null,
      folderId: null,
      nginxTemplateId: null,
      templateVariables: {},
      nodeId: input.nodeId,
      healthCheckEnabled: false,
      healthCheckUrl: '/v2/',
      healthCheckInterval: 30,
      healthCheckExpectedStatus: null,
      healthCheckExpectedBody: null,
      healthCheckBodyMatchMode: 'includes' as const,
      healthCheckSlowThreshold: 3,
      healthStatus: 'disabled' as const,
      isSystem: true,
      systemKind: 'docker_registry',
      updatedAt: new Date(),
    };

    const createdNew = !existing;
    const previousNodeId = existing?.nodeId ?? null;
    const writeHost = async (slug?: string) => {
      const [host] = existing
        ? await this.db
            .update(proxyHosts)
            .set({ ...data, ...(slug === undefined ? {} : { slug }) })
            .where(eq(proxyHosts.id, existing.id))
            .returning()
        : userId
          ? await this.db
              .insert(proxyHosts)
              .values({
                id: INTERNAL_REGISTRY_INGRESS_ID,
                ...data,
                slug: slug!,
                createdById: userId,
              })
              .returning()
          : (() => {
              throw new AppError(
                503,
                'REGISTRY_INGRESS_OWNER_UNAVAILABLE',
                'Registry ingress cannot be recreated without its original owner'
              );
            })();
      return host;
    };
    const primaryDomainChanged = !existing || existing.domainNames[0] !== input.domain;
    const host = primaryDomainChanged
      ? await writeWithAllocatedSlug({
          source: input.domain,
          fallback: 'internal-registry',
          reserved: ['new'],
          constraint: 'proxy_hosts_slug_unique',
          write: writeHost,
        })
      : await writeHost();

    try {
      const certPaths = await this.resolveCertPaths(host);
      const config = await this.buildNginxConfig(host, certPaths, null);
      await this.applyConfigToNode(host.id, config, host.nodeId, certPaths.preparedTls, 'user_owned');
      if (previousNodeId && previousNodeId !== host.nodeId) {
        try {
          await this.removeConfigFromNode(host.id, previousNodeId);
          await this.certificateDistribution.deactivateHost(host.id, previousNodeId);
        } catch (cleanupError) {
          logger.warn('Registry ingress moved but old Nginx config requires deferred cleanup', {
            hostId: host.id,
            nodeId: previousNodeId,
            error: cleanupError,
          });
        }
      }
    } catch (error) {
      logger.error('Failed to apply internal registry system proxy host config', { hostId: host.id, error });
      if (createdNew) {
        await this.db.delete(proxyHosts).where(eq(proxyHosts.id, host.id));
      } else if (existing) {
        await this.db
          .update(proxyHosts)
          .set({ ...buildStatusPageSystemHostRollbackData(existing), slug: existing.slug } as any)
          .where(eq(proxyHosts.id, existing.id));
      }
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to apply registry ingress config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    await this.auditService.log({
      userId,
      action: existing ? 'proxy_host.system_update' : 'proxy_host.system_create',
      resourceType: 'proxy_host',
      resourceId: host.id,
      details: { systemKind: 'docker_registry', domain: input.domain, nodeId: input.nodeId },
    });
    this.emitHost(host.id, 'updated', input.domain);
    return host;
  }

  async disableRegistrySystemHost(userId: string | null): Promise<ProxyHostRow | null> {
    const existing = await this.db.query.proxyHosts.findFirst({
      where: eq(proxyHosts.systemKind, 'docker_registry'),
    });
    if (!existing) return null;
    try {
      await this.removeConfigFromNode(existing.id, existing.nodeId);
      await this.certificateDistribution.deactivateHost(existing.id, existing.nodeId);
      await this.db.delete(proxyHosts).where(eq(proxyHosts.id, existing.id));
    } catch (error) {
      logger.error('Failed to remove internal registry system proxy host config', { hostId: existing.id, error });
      throw new AppError(
        500,
        'NGINX_CONFIG_FAILED',
        `Failed to disable registry ingress config: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }
    await this.auditService.log({
      userId,
      action: 'proxy_host.system_disable',
      resourceType: 'proxy_host',
      resourceId: existing.id,
      details: { systemKind: 'docker_registry' },
    });
    this.emitHost(existing.id, 'deleted', existing.domainNames?.[0]);
    return existing;
  }

  // -----------------------------------------------------------------------
  // Validate advanced config snippet
  // -----------------------------------------------------------------------
}
