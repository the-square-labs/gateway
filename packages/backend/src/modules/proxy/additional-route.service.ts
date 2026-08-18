import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  nginxTemplates,
  pageDeployments,
  pageProjects,
  pageTags,
  proxyAdditionalRoutes,
  proxyAdditionalSecureLinks,
  proxyHosts,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { PageNodeRuntimeService } from '@/modules/pages/runtime/page-node-runtime.service.js';
import type {
  PageRuntimeConfigPublicationRequest,
  PageRuntimeConfigService,
} from '@/modules/pages/runtime-config/page-runtime-config.service.js';
import type { PageTagActivationRequest } from '@/modules/pages/tags/page-tag.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { ProxyAdditionalRouteConfig } from '@/services/nginx-config-generator.service.js';
import { normalizeAdditionalRoutePath } from './additional-route.validation.js';
import type { ProxyDockerUpstreamService } from './proxy-docker-upstream.service.js';
import type { CreateProxyAdditionalSecureLinkInput, ProxySecureLinkService } from './proxy-secure-link.service.js';

const logger = createChildLogger('AdditionalRouteService');

type ProxyHostRow = typeof proxyHosts.$inferSelect;
type AdditionalRouteRow = typeof proxyAdditionalRoutes.$inferSelect;
type Input = Record<string, unknown>;

interface ProxyHostRuntimeAdapter {
  reconcileAdditionalRouteHost(hostId: string): Promise<void>;
}

interface NormalizedTarget {
  targetKind: 'manual' | 'docker_container' | 'docker_deployment' | 'pages';
  forwardHost?: string | null;
  forwardPort?: number | null;
  forwardScheme: 'http' | 'https';
  dockerNodeId?: string | null;
  dockerContainerName?: string | null;
  dockerDeploymentId?: string | null;
  dockerContainerPort?: number | null;
  dockerHostPort?: number | null;
  dockerProtocol?: 'tcp' | null;
  pageProjectId?: string | null;
  pageTagId?: string | null;
}

interface AdditionalRuntimeConfigProgress {
  routeId: string;
  hostId: string;
  nodeId: string;
  from: number;
  to: number;
  fromRouteGeneration: number;
  toRouteGeneration: number;
}

export interface AdditionalRouteNodeMigration {
  hostId: string;
  sourceNodeId: string;
  targetNodeId: string;
  routeIds: string[];
  generation: number;
  routes: Array<{
    routeId: string;
    targetKind: AdditionalRouteRow['targetKind'];
    generation: number;
    previousSecureLinkId: string | null;
    stagedSecureLinkId: string | null;
    previousIncludePath: string | null;
    previousRuntimeConfigGeneration: number;
  }>;
}

function isDockerKind(kind: string): kind is 'docker_container' | 'docker_deployment' {
  return kind === 'docker_container' || kind === 'docker_deployment';
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505'
  );
}

function readInput(input: Input, target: Input | undefined, key: string): unknown {
  return input[key] ?? target?.[key];
}

export class AdditionalRouteService {
  private eventBus?: EventBusService;
  private hostRuntime?: ProxyHostRuntimeAdapter;
  private pageRuntime?: PageNodeRuntimeService;
  private pageRuntimeConfig?: PageRuntimeConfigService;
  private readonly hostLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly dockerUpstreams?: ProxyDockerUpstreamService,
    private readonly secureLinks?: ProxySecureLinkService
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
    eventBus.subscribe('pages.tag.changed', (payload) => {
      const event = payload as { tagId?: string; action?: string };
      if (event.tagId && event.action && /publish|activated|moved|ready/i.test(event.action)) {
        void this.reconcileByTag(event.tagId).catch((error) =>
          logger.warn('Additional Pages routes reconcile failed', { error })
        );
      }
    });
    eventBus.subscribe('pages.config.changed', (payload) => {
      const event = payload as { projectId?: string; tagId?: string | null };
      if (event.projectId) {
        void this.reconcileByProject(event.projectId, event.tagId).catch((error) =>
          logger.warn('Additional Pages runtime-config reconcile failed', { error })
        );
      }
    });
  }

  setHostRuntime(adapter: ProxyHostRuntimeAdapter): void {
    this.hostRuntime = adapter;
  }

  setPageRuntime(runtime: PageNodeRuntimeService, runtimeConfig: PageRuntimeConfigService): void {
    this.pageRuntime = runtime;
    this.pageRuntimeConfig = runtimeConfig;
  }

  private async withHostLock<T>(hostId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.hostLocks.get(hostId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.hostLocks.set(hostId, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.hostLocks.get(hostId) === queued) this.hostLocks.delete(hostId);
    }
  }

  async requireHost(hostId: string): Promise<ProxyHostRow> {
    const host = await this.db.query.proxyHosts.findFirst({ where: eq(proxyHosts.id, hostId) });
    if (!host) throw new AppError(404, 'PROXY_HOST_NOT_FOUND', 'Proxy host not found');
    return host;
  }

  /** Service-level gate used by CRUD and by direct ProxyService callers. */
  async assertHostCanUse(host: ProxyHostRow): Promise<void> {
    if (host.type !== 'proxy' || host.rawConfigEnabled) {
      throw new AppError(409, 'ADDITIONAL_ROUTES_UNAVAILABLE', 'Additional Routes require a managed proxy host');
    }
    if (host.nginxTemplateId) {
      const template = await this.db.query.nginxTemplates.findFirst({
        where: eq(nginxTemplates.id, host.nginxTemplateId),
      });
      if (!template?.isBuiltin || template.type !== 'proxy') {
        throw new AppError(
          409,
          'ADDITIONAL_ROUTES_TEMPLATE_UNSUPPORTED',
          'Additional Routes require the managed proxy template'
        );
      }
    }
  }

  async assertHostTemplateMutationAllowed(host: ProxyHostRow, input: Input): Promise<void> {
    const count = await this.db
      .select({ id: proxyAdditionalRoutes.id })
      .from(proxyAdditionalRoutes)
      .where(eq(proxyAdditionalRoutes.proxyHostId, host.id))
      .limit(1);
    if (count.length === 0) return;
    if (host.type === 'proxy' && (input.type === 'redirect' || input.type === '404')) {
      throw new AppError(
        409,
        'ADDITIONAL_ROUTES_HOST_MODE_BLOCKED',
        'Remove Additional Routes before changing this host from Proxy to Redirect or 404'
      );
    }
    const entersRaw = input.type === 'raw' || input.rawConfigEnabled === true;
    const customTemplate = input.nginxTemplateId !== undefined && input.nginxTemplateId !== null;
    if (!entersRaw && !customTemplate) return;
    throw new AppError(
      409,
      'ADDITIONAL_ROUTES_HOST_MODE_BLOCKED',
      'Remove Additional Routes before switching this host to raw mode or a custom template'
    );
  }

  async list(hostId: string) {
    await this.requireHost(hostId);
    return this.db
      .select({
        route: proxyAdditionalRoutes,
        pageProjectName: pageProjects.name,
        pageProjectSlug: pageProjects.slug,
        pageProjectAppearanceColor: pageProjects.appearanceColor,
        pageTagName: pageTags.name,
      })
      .from(proxyAdditionalRoutes)
      .leftJoin(pageProjects, eq(proxyAdditionalRoutes.pageProjectId, pageProjects.id))
      .leftJoin(pageTags, eq(proxyAdditionalRoutes.pageTagId, pageTags.id))
      .where(eq(proxyAdditionalRoutes.proxyHostId, hostId))
      .orderBy(proxyAdditionalRoutes.path)
      .then((rows) => rows.map(({ route, ...labels }) => ({ ...route, ...labels })));
  }

  async present(route: AdditionalRouteRow) {
    const [view] = await this.db
      .select({
        pageProjectName: pageProjects.name,
        pageProjectSlug: pageProjects.slug,
        pageProjectAppearanceColor: pageProjects.appearanceColor,
        pageTagName: pageTags.name,
      })
      .from(proxyAdditionalRoutes)
      .leftJoin(pageProjects, eq(proxyAdditionalRoutes.pageProjectId, pageProjects.id))
      .leftJoin(pageTags, eq(proxyAdditionalRoutes.pageTagId, pageTags.id))
      .where(eq(proxyAdditionalRoutes.id, route.id))
      .limit(1);
    return { ...route, ...view };
  }

  async get(hostId: string, routeId: string): Promise<AdditionalRouteRow> {
    const [route] = await this.db
      .select()
      .from(proxyAdditionalRoutes)
      .where(and(eq(proxyAdditionalRoutes.id, routeId), eq(proxyAdditionalRoutes.proxyHostId, hostId)))
      .limit(1);
    if (!route) throw new AppError(404, 'ADDITIONAL_ROUTE_NOT_FOUND', 'Additional Route not found');
    return route;
  }

  private normalizeTarget(input: Input, existing?: AdditionalRouteRow): NormalizedTarget {
    const nested =
      input.target && typeof input.target === 'object' && !Array.isArray(input.target)
        ? (input.target as Input)
        : undefined;
    const targetKind = String(
      input.targetKind ?? input.targetType ?? nested?.kind ?? nested?.targetKind ?? existing?.targetKind ?? ''
    ) as NormalizedTarget['targetKind'];
    if (!['manual', 'docker_container', 'docker_deployment', 'pages'].includes(targetKind)) {
      throw new AppError(400, 'ADDITIONAL_ROUTE_TARGET_REQUIRED', 'A route target is required');
    }
    const value = (key: string): unknown => readInput(input, nested, key);
    const sameKind = existing?.targetKind === targetKind;
    return {
      targetKind,
      forwardHost:
        targetKind === 'manual'
          ? ((value('forwardHost') as string | null | undefined) ?? (sameKind ? existing?.forwardHost : null) ?? null)
          : null,
      forwardPort:
        targetKind === 'manual'
          ? ((value('forwardPort') as number | null | undefined) ?? (sameKind ? existing?.forwardPort : null) ?? null)
          : null,
      forwardScheme: (value('forwardScheme') as 'http' | 'https' | undefined) ?? existing?.forwardScheme ?? 'http',
      dockerNodeId: isDockerKind(targetKind)
        ? ((value('dockerNodeId') as string | null | undefined) ?? (sameKind ? existing?.dockerNodeId : null) ?? null)
        : null,
      dockerContainerName:
        targetKind === 'docker_container'
          ? ((value('dockerContainerName') as string | null | undefined) ??
            (sameKind ? existing?.dockerContainerName : null) ??
            null)
          : null,
      dockerDeploymentId:
        targetKind === 'docker_deployment'
          ? ((value('dockerDeploymentId') as string | null | undefined) ??
            (sameKind ? existing?.dockerDeploymentId : null) ??
            null)
          : null,
      dockerContainerPort: isDockerKind(targetKind)
        ? ((value('dockerContainerPort') as number | null | undefined) ??
          (sameKind ? existing?.dockerContainerPort : null) ??
          null)
        : null,
      dockerHostPort: isDockerKind(targetKind)
        ? ((value('dockerHostPort') as number | null | undefined) ??
          (sameKind ? existing?.dockerHostPort : null) ??
          null)
        : null,
      dockerProtocol: isDockerKind(targetKind)
        ? ((value('dockerProtocol') as 'tcp' | undefined) ??
          (sameKind ? (existing?.dockerProtocol as 'tcp' | null | undefined) : null) ??
          'tcp')
        : null,
      pageProjectId:
        targetKind === 'pages'
          ? ((value('pageProjectId') as string | null | undefined) ??
            (sameKind ? existing?.pageProjectId : null) ??
            null)
          : null,
      pageTagId:
        targetKind === 'pages'
          ? ((value('pageTagId') as string | null | undefined) ?? (sameKind ? existing?.pageTagId : null) ?? null)
          : null,
    };
  }

  private async validateTarget(host: ProxyHostRow, target: NormalizedTarget, actorScopes: string[]): Promise<void> {
    if (target.forwardScheme !== 'http' && target.forwardScheme !== 'https') {
      throw new AppError(400, 'INVALID_ROUTE_SCHEME', 'Route scheme must be HTTP or HTTPS');
    }
    if (target.targetKind === 'manual') {
      if (!target.forwardHost || !/^[A-Za-z0-9._-]+$/.test(target.forwardHost))
        throw new AppError(400, 'MANUAL_UPSTREAM_REQUIRED', 'Forward host is required');
      if (!target.forwardPort || target.forwardPort < 1 || target.forwardPort > 65535)
        throw new AppError(400, 'MANUAL_UPSTREAM_REQUIRED', 'Forward host and port are required');
      return;
    }
    if (isDockerKind(target.targetKind)) {
      if (target.dockerProtocol !== 'tcp') {
        throw new AppError(400, 'INVALID_DOCKER_PROTOCOL', 'Docker Additional Routes require TCP');
      }
      if (!this.dockerUpstreams)
        throw new AppError(503, 'DOCKER_UPSTREAMS_UNAVAILABLE', 'Docker upstream resolution is unavailable');
      await this.dockerUpstreams.resolve(
        {
          upstreamKind: target.targetKind,
          dockerNodeId: target.dockerNodeId,
          dockerContainerName: target.dockerContainerName,
          dockerDeploymentId: target.dockerDeploymentId,
          dockerContainerPort: target.dockerContainerPort,
          dockerHostPort: target.dockerHostPort,
          dockerProtocol: target.dockerProtocol,
        },
        { actorScopes, requireAvailable: true }
      );
      return;
    }
    if (!target.pageProjectId || !target.pageTagId) {
      throw new AppError(400, 'PAGES_ROUTE_TARGET_REQUIRED', 'Select both a Page Project and Tag');
    }
    if (!hasScope(actorScopes, `pages:view:${target.pageProjectId}`)) {
      throw new AppError(403, 'FORBIDDEN', 'Viewing the selected Page Project is required');
    }
    if (!host.nodeId) throw new AppError(409, 'PAGES_ROUTE_NODE_MISSING', 'Pages Route host has no Nginx node');
    const [targetRow] = await this.db
      .select({ deploymentId: pageTags.deploymentId, generation: pageTags.generation })
      .from(pageTags)
      .innerJoin(pageDeployments, eq(pageTags.deploymentId, pageDeployments.id))
      .where(
        and(
          eq(pageTags.id, target.pageTagId),
          eq(pageTags.projectId, target.pageProjectId),
          eq(pageDeployments.status, 'ready')
        )
      )
      .limit(1);
    if (!targetRow?.deploymentId)
      throw new AppError(409, 'PAGES_TAG_NOT_DEPLOYED', 'Select a Tag with a ready Deployment');
    if (!this.pageRuntime || !this.pageRuntimeConfig)
      throw new AppError(503, 'PAGES_ROUTE_UNAVAILABLE', 'Pages Route runtime is unavailable');
    await this.pageRuntime.preflight(host.nodeId, 0);
  }

  private asSecureLinkInput(target: NormalizedTarget): CreateProxyAdditionalSecureLinkInput {
    if (!isDockerKind(target.targetKind) || !target.dockerContainerPort) {
      throw new AppError(400, 'INVALID_DOCKER_TARGET', 'A Docker target and application port are required');
    }
    return {
      name: 'route',
      upstreamKind: target.targetKind,
      forwardScheme: target.forwardScheme,
      dockerNodeId: target.dockerNodeId,
      dockerContainerName: target.dockerContainerName,
      dockerDeploymentId: target.dockerDeploymentId,
      dockerContainerPort: target.dockerContainerPort,
    };
  }

  async create(hostId: string, input: Input, userId: string, actorScopes: string[]): Promise<AdditionalRouteRow> {
    return this.withHostLock(hostId, async () => {
      const host = await this.requireHost(hostId);
      await this.assertHostCanUse(host);
      const target = this.normalizeTarget(input);
      await this.validateTarget(host, target, actorScopes);
      const path = normalizeAdditionalRoutePath(String(input.path ?? ''));
      const enabled = input.enabled !== false;
      const options = this.routeOptions(input, target);
      let created: AdditionalRouteRow;
      try {
        [created] = await this.db
          .insert(proxyAdditionalRoutes)
          .values({
            proxyHostId: host.id,
            path,
            enabled,
            ...target,
            ...options,
            advancedConfig: typeof input.advancedConfig === 'string' ? input.advancedConfig || null : null,
            status: enabled ? 'staging' : 'disabled',
            generation: 1,
            createdById: userId,
            updatedById: userId,
          })
          .returning();
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(409, 'ADDITIONAL_ROUTE_PATH_EXISTS', 'A route already uses this path');
        throw error;
      }
      if (!created) throw new AppError(500, 'ADDITIONAL_ROUTE_CREATE_FAILED', 'Additional Route was not created');

      try {
        if (enabled) {
          created = await this.provision(created, host, target);
          if (target.targetKind !== 'pages') await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
        }
      } catch (error) {
        created = (await this.markFailed(created.id, error, userId)) ?? created;
      }
      await this.auditService.log({
        userId,
        action: 'proxy.additional_route.create',
        resourceType: 'proxy_additional_route',
        resourceId: created.id,
        details: { proxyHostId: host.id, path: created.path, targetKind: created.targetKind },
      });
      this.emit(created, 'created');
      return created;
    });
  }

  async update(
    hostId: string,
    routeId: string,
    input: Input,
    userId: string,
    actorScopes: string[]
  ): Promise<AdditionalRouteRow> {
    return this.withHostLock(hostId, async () => {
      const host = await this.requireHost(hostId);
      await this.assertHostCanUse(host);
      const existing = await this.get(hostId, routeId);
      const target = this.normalizeTarget(input, existing);
      await this.validateTarget(host, target, actorScopes);
      const path = input.path === undefined ? existing.path : normalizeAdditionalRoutePath(String(input.path));
      const enabled = input.enabled === undefined ? existing.enabled : Boolean(input.enabled);
      const options = this.routeOptions({ ...existing, ...input }, target);
      const targetChanged = this.targetChanged(existing, target);
      const resetMaterialization = !enabled
        ? {
            secureLinkId: null,
            activeDeploymentId: null,
            includePath: null,
            runtimeConfigPath: null,
            runtimeConfigGeneration: 0,
          }
        : {};
      const [staged] = await this.db
        .update(proxyAdditionalRoutes)
        .set({
          path,
          enabled,
          ...target,
          ...options,
          advancedConfig:
            input.advancedConfig === undefined
              ? existing.advancedConfig
              : typeof input.advancedConfig === 'string' && input.advancedConfig.length > 0
                ? input.advancedConfig
                : null,
          ...resetMaterialization,
          status: enabled ? 'staging' : 'disabled',
          generation: existing.generation + 1,
          lastError: null,
          updatedById: userId,
          updatedAt: new Date(),
        })
        .where(and(eq(proxyAdditionalRoutes.id, routeId), eq(proxyAdditionalRoutes.proxyHostId, hostId)))
        .returning();
      if (!staged) throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Route changed concurrently');
      let ready: AdditionalRouteRow | null = null;
      try {
        ready = enabled ? await this.provision(staged, host, target) : staged;
        if (enabled && ready.status !== 'ready') {
          throw new Error(ready.lastError ?? 'Additional Route target did not become ready');
        }
        if (!enabled || target.targetKind !== 'pages') await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
        try {
          if (
            (!enabled || (targetChanged && !isDockerKind(target.targetKind))) &&
            this.secureLinks &&
            isDockerKind(existing.targetKind)
          ) {
            if (existing.secureLinkId) {
              await this.secureLinks.deleteManagedRouteBinding(host, existing.secureLinkId);
            } else {
              await this.secureLinks.deleteManagedRoute(host, routeId);
            }
          } else if (
            targetChanged &&
            isDockerKind(target.targetKind) &&
            isDockerKind(existing.targetKind) &&
            existing.secureLinkId &&
            ready.secureLinkId !== existing.secureLinkId
          ) {
            await this.secureLinks?.deleteManagedRouteBinding(host, existing.secureLinkId);
          }
          if ((!enabled || (targetChanged && target.targetKind !== 'pages')) && existing.targetKind === 'pages') {
            await this.cleanupPages(existing, host.nodeId);
          }
        } catch (cleanupError) {
          logger.warn('Additional Route previous target cleanup failed after successful retarget', {
            routeId,
            cleanupError,
          });
        }
        await this.auditService.log({
          userId,
          action: 'proxy.additional_route.update',
          resourceType: 'proxy_additional_route',
          resourceId: routeId,
          details: { proxyHostId: host.id, changes: Object.keys(input) },
        });
        this.emit(ready, 'updated');
        return ready;
      } catch (error) {
        if (targetChanged) {
          try {
            if (existing.targetKind === 'pages' && existing.activeDeploymentId) {
              await this.restorePagesMaterialization(
                host.nodeId!,
                existing.id,
                existing.activeDeploymentId,
                existing.runtimeConfigGeneration
              );
            }
            await this.restoreRetarget(existing, userId);
            await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
            if (
              ready?.secureLinkId &&
              ready.secureLinkId !== existing.secureLinkId &&
              isDockerKind(target.targetKind)
            ) {
              await this.secureLinks?.deleteManagedRouteBinding(host, ready.secureLinkId).catch(() => undefined);
            }
            if (target.targetKind === 'pages' && existing.targetKind !== 'pages' && ready) {
              await this.cleanupPages(ready, host.nodeId).catch(() => undefined);
            }
            logger.warn('Additional Route retarget rolled back to the previous ready target', { routeId, error });
          } catch (rollbackError) {
            logger.error('Additional Route retarget rollback failed', { routeId, error, rollbackError });
            // Fall through to the retryable failed state when the previous
            // materialization could not be restored safely.
            const [failed] = await this.db
              .update(proxyAdditionalRoutes)
              .set({
                status: 'failed',
                lastError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                updatedAt: new Date(),
              })
              .where(eq(proxyAdditionalRoutes.id, routeId))
              .returning();
            return failed ?? (await this.get(hostId, routeId));
          }
          throw error;
        }
        // Restore the persisted intent. Runtime cleanup is best effort and the
        // failed generation remains visible for an explicit retry.
        await this.db
          .update(proxyAdditionalRoutes)
          .set({
            status: enabled ? 'failed' : 'cleanup_pending',
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: new Date(),
          })
          .where(eq(proxyAdditionalRoutes.id, routeId));
        const current = await this.get(hostId, routeId);
        logger.warn('Additional Route update left in retryable failed state', { routeId, error });
        return current;
      }
    });
  }

  private async restoreRetarget(previous: AdditionalRouteRow, userId: string): Promise<AdditionalRouteRow> {
    const current = await this.get(previous.proxyHostId, previous.id);
    const [restored] = await this.db
      .update(proxyAdditionalRoutes)
      .set({
        path: previous.path,
        enabled: previous.enabled,
        targetKind: previous.targetKind,
        forwardHost: previous.forwardHost,
        forwardPort: previous.forwardPort,
        forwardScheme: previous.forwardScheme,
        dockerNodeId: previous.dockerNodeId,
        dockerContainerName: previous.dockerContainerName,
        dockerDeploymentId: previous.dockerDeploymentId,
        dockerContainerPort: previous.dockerContainerPort,
        dockerHostPort: previous.dockerHostPort,
        dockerProtocol: previous.dockerProtocol,
        pageProjectId: previous.pageProjectId,
        pageTagId: previous.pageTagId,
        secureLinkId: previous.secureLinkId,
        activeDeploymentId: previous.activeDeploymentId,
        includePath: previous.includePath,
        runtimeConfigPath: previous.runtimeConfigPath,
        runtimeConfigGeneration: previous.runtimeConfigGeneration,
        advancedConfig: previous.advancedConfig,
        stripPrefix: previous.stripPrefix,
        websocketSupport: previous.websocketSupport,
        requestBuffering: previous.requestBuffering,
        responseBuffering: previous.responseBuffering,
        connectTimeoutSeconds: previous.connectTimeoutSeconds,
        readTimeoutSeconds: previous.readTimeoutSeconds,
        sendTimeoutSeconds: previous.sendTimeoutSeconds,
        status: previous.status,
        generation: current.generation + 1,
        lastError: null,
        updatedById: userId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(proxyAdditionalRoutes.id, previous.id),
          eq(proxyAdditionalRoutes.proxyHostId, previous.proxyHostId),
          eq(proxyAdditionalRoutes.generation, current.generation)
        )
      )
      .returning();
    if (!restored) throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Route changed during rollback');
    return restored;
  }

  async retry(hostId: string, routeId: string, userId: string, actorScopes: string[]): Promise<AdditionalRouteRow> {
    return this.withHostLock(hostId, async () => {
      const host = await this.requireHost(hostId);
      await this.assertHostCanUse(host);
      const existing = await this.get(hostId, routeId);
      const target = this.normalizeTarget(existing as unknown as Input, existing);
      await this.validateTarget(host, target, actorScopes);
      const [staged] = await this.db
        .update(proxyAdditionalRoutes)
        .set({
          status: 'staging',
          generation: existing.generation + 1,
          lastError: null,
          updatedById: userId,
          updatedAt: new Date(),
        })
        .where(eq(proxyAdditionalRoutes.id, routeId))
        .returning();
      if (!staged) throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Route changed concurrently');
      try {
        if (isDockerKind(target.targetKind)) await this.secureLinks?.deleteManagedRoute(host, routeId);
        if (target.targetKind === 'pages') await this.cleanupPages(existing, host.nodeId);
        const ready = await this.provision(staged, host, target);
        if (target.targetKind !== 'pages') await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
        await this.auditService.log({
          userId,
          action: 'proxy.additional_route.retry',
          resourceType: 'proxy_additional_route',
          resourceId: routeId,
        });
        this.emit(ready, 'retried');
        return ready;
      } catch (error) {
        return (await this.markFailed(routeId, error, userId)) ?? staged;
      }
    });
  }

  async remove(hostId: string, routeId: string, userId: string): Promise<void> {
    return this.withHostLock(hostId, async () => {
      const host = await this.requireHost(hostId);
      const existing = await this.get(hostId, routeId);
      // Stage the config removal before touching relay/Pages state.
      const [pending] = await this.db
        .update(proxyAdditionalRoutes)
        .set({
          status: 'cleanup_pending',
          enabled: false,
          generation: existing.generation + 1,
          updatedById: userId,
          updatedAt: new Date(),
        })
        .where(eq(proxyAdditionalRoutes.id, routeId))
        .returning();
      if (!pending) throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Route changed concurrently');
      try {
        await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
        if (isDockerKind(existing.targetKind)) await this.secureLinks?.deleteManagedRoute(host, routeId);
        if (existing.targetKind === 'pages') await this.cleanupPages(existing, host.nodeId);
        await this.db.delete(proxyAdditionalRoutes).where(eq(proxyAdditionalRoutes.id, routeId));
      } catch (error) {
        await this.db
          .update(proxyAdditionalRoutes)
          .set({
            status: 'cleanup_pending',
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: new Date(),
          })
          .where(eq(proxyAdditionalRoutes.id, routeId));
        throw error;
      }
      await this.auditService.log({
        userId,
        action: 'proxy.additional_route.delete',
        resourceType: 'proxy_additional_route',
        resourceId: routeId,
        details: { proxyHostId: host.id, path: existing.path },
      });
      this.emit(existing, 'deleted');
    });
  }

  async cleanupForHost(host: ProxyHostRow, abandonOfflineNode = false): Promise<void> {
    const routes = await this.db.query.proxyAdditionalRoutes.findMany({
      where: eq(proxyAdditionalRoutes.proxyHostId, host.id),
    });
    for (const route of routes) {
      if (route.targetKind === 'pages' && !abandonOfflineNode) {
        await this.cleanupPages(route, host.nodeId);
      }
    }
    // The Secure Link service owns the hidden relay bindings and is called by
    // ProxyService immediately before this method.  Keep route rows durable
    // until the host cascade; offline deletion intentionally leaves daemon
    // cleanup to the existing deferred relay reconciliation.
  }

  /**
   * Stage route-owned listeners/fragments on a new ingress node.  The old
   * listener and Pages materialization remain active until ProxyService has
   * applied the destination host configuration and calls commitNodeMigration.
   */
  async stageNodeMigration(
    hostId: string,
    sourceNodeId: string,
    targetNodeId: string
  ): Promise<AdditionalRouteNodeMigration> {
    return this.withHostLock(hostId, async () => {
      const host = await this.requireHost(hostId);
      const rows = await this.db.query.proxyAdditionalRoutes.findMany({
        where: and(
          eq(proxyAdditionalRoutes.proxyHostId, hostId),
          eq(proxyAdditionalRoutes.enabled, true),
          eq(proxyAdditionalRoutes.status, 'ready'),
          inArray(proxyAdditionalRoutes.targetKind, ['docker_container', 'docker_deployment', 'pages'])
        ),
        orderBy: (route, { asc }) => [asc(route.id)],
      });
      const progress: AdditionalRouteNodeMigration['routes'] = [];
      try {
        for (const route of rows) {
          if (isDockerKind(route.targetKind)) {
            if (!this.secureLinks || !route.secureLinkId) {
              throw new AppError(
                409,
                'SECURE_LINK_ROUTE_NOT_READY',
                'Docker Additional Route Secure Link is unavailable'
              );
            }
            const binding = await this.db.query.proxyAdditionalSecureLinks.findFirst({
              where: and(
                eq(proxyAdditionalSecureLinks.id, route.secureLinkId),
                eq(proxyAdditionalSecureLinks.purpose, 'additional_route'),
                eq(proxyAdditionalSecureLinks.status, 'active')
              ),
            });
            if (!binding || binding.sourceNodeId !== sourceNodeId) {
              throw new AppError(409, 'SECURE_LINK_ROUTE_CHANGED', 'Docker Additional Route changed during migration');
            }
            const stagedBinding = await this.secureLinks.stageManagedRouteMigration(host, route.id, targetNodeId);
            const [staged] = await this.db
              .update(proxyAdditionalRoutes)
              .set({
                secureLinkId: stagedBinding.stagedBindingId,
                migrationSourceNodeId: sourceNodeId,
                migrationTargetNodeId: targetNodeId,
                migrationPreviousSecureLinkId: route.secureLinkId,
                migrationPreviousIncludePath: null,
                migrationPreviousRuntimeConfigGeneration: route.runtimeConfigGeneration,
                status: 'staging',
                generation: route.generation + 1,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(proxyAdditionalRoutes.id, route.id),
                  eq(proxyAdditionalRoutes.generation, route.generation),
                  eq(proxyAdditionalRoutes.status, 'ready'),
                  eq(proxyAdditionalRoutes.secureLinkId, route.secureLinkId)
                )
              )
              .returning({ generation: proxyAdditionalRoutes.generation });
            if (!staged) {
              await this.secureLinks.deleteManagedRouteBinding(host, stagedBinding.stagedBindingId);
              throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Route changed concurrently');
            }
            progress.push({
              routeId: route.id,
              targetKind: route.targetKind,
              generation: staged.generation,
              previousSecureLinkId: route.secureLinkId,
              stagedSecureLinkId: stagedBinding.stagedBindingId,
              previousIncludePath: null,
              previousRuntimeConfigGeneration: route.runtimeConfigGeneration,
            });
            continue;
          }

          if (
            !this.pageRuntime ||
            !this.pageRuntimeConfig ||
            !route.pageProjectId ||
            !route.pageTagId ||
            !route.activeDeploymentId
          ) {
            throw new AppError(409, 'PAGES_ROUTE_UNAVAILABLE', 'Pages Additional Route runtime is unavailable');
          }
          const effective = await this.pageRuntimeConfig.getEffective(route.pageProjectId, route.pageTagId);
          const runtimeGeneration = route.runtimeConfigGeneration || 1;
          const runtimeConfigPath = await this.pageRuntime.publishRuntimeConfig(
            targetNodeId,
            'route',
            route.id,
            runtimeGeneration,
            effective.value
          );
          let includePath: string;
          try {
            includePath = await this.pageRuntime.activateRoute(targetNodeId, route.id, route.activeDeploymentId);
          } catch (error) {
            await this.pageRuntime.removeRuntimeConfig(targetNodeId, 'route', route.id).catch(() => undefined);
            throw error;
          }
          const [staged] = await this.db
            .update(proxyAdditionalRoutes)
            .set({
              includePath,
              runtimeConfigPath,
              migrationSourceNodeId: sourceNodeId,
              migrationTargetNodeId: targetNodeId,
              migrationPreviousSecureLinkId: null,
              migrationPreviousIncludePath: route.includePath,
              migrationPreviousRuntimeConfigGeneration: route.runtimeConfigGeneration,
              status: 'staging',
              generation: route.generation + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(proxyAdditionalRoutes.id, route.id),
                eq(proxyAdditionalRoutes.generation, route.generation),
                eq(proxyAdditionalRoutes.status, 'ready')
              )
            )
            .returning({ generation: proxyAdditionalRoutes.generation });
          if (!staged) {
            await this.pageRuntime.deactivateRoute(targetNodeId, route.id).catch(() => undefined);
            await this.pageRuntime.removeRuntimeConfig(targetNodeId, 'route', route.id).catch(() => undefined);
            throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Route changed concurrently');
          }
          progress.push({
            routeId: route.id,
            targetKind: route.targetKind,
            generation: staged.generation,
            previousSecureLinkId: null,
            stagedSecureLinkId: null,
            previousIncludePath: route.includePath,
            previousRuntimeConfigGeneration: route.runtimeConfigGeneration,
          });
        }
        return {
          hostId,
          sourceNodeId,
          targetNodeId,
          routeIds: progress.map((route) => route.routeId),
          generation: progress.reduce((max, route) => Math.max(max, route.generation), 0),
          routes: progress,
        };
      } catch (error) {
        await this.rollbackNodeMigrationLocked({
          hostId,
          sourceNodeId,
          targetNodeId,
          routeIds: progress.map((route) => route.routeId),
          generation: progress.reduce((max, route) => Math.max(max, route.generation), 0),
          routes: progress,
        }).catch((rollbackError) =>
          logger.error('Additional Route migration rollback failed', { hostId, rollbackError })
        );
        throw error;
      }
    });
  }

  async commitNodeMigration(migration: AdditionalRouteNodeMigration): Promise<void> {
    await this.withHostLock(migration.hostId, async () => {
      const host = await this.requireHost(migration.hostId);
      for (const item of migration.routes) {
        const [current] = await this.db
          .select()
          .from(proxyAdditionalRoutes)
          .where(eq(proxyAdditionalRoutes.id, item.routeId))
          .limit(1);
        if (!current) continue;
        if (
          current.migrationTargetNodeId !== migration.targetNodeId ||
          current.migrationSourceNodeId !== migration.sourceNodeId ||
          current.generation !== item.generation
        ) {
          if (current.migrationTargetNodeId === null && current.status === 'ready') continue;
          throw new AppError(
            409,
            'ADDITIONAL_ROUTE_MIGRATION_OWNERSHIP_LOST',
            'Additional Route migration claim was lost'
          );
        }

        let cleanupComplete = true;
        if (item.targetKind === 'pages') {
          if (this.pageRuntime) {
            try {
              await this.pageRuntime.deactivateRoute(migration.sourceNodeId, item.routeId);
              await this.pageRuntime.removeRuntimeConfig(migration.sourceNodeId, 'route', item.routeId);
            } catch (error) {
              cleanupComplete = false;
              logger.warn('Additional Pages Route source cleanup will retry', { routeId: item.routeId, error });
            }
          }
        } else if (item.previousSecureLinkId && this.secureLinks) {
          try {
            await this.secureLinks.deleteManagedRouteBinding(host, item.previousSecureLinkId);
          } catch (error) {
            cleanupComplete = false;
            logger.warn('Additional Route source Secure Link cleanup will retry', { routeId: item.routeId, error });
          }
        }
        if (cleanupComplete) {
          await this.db
            .update(proxyAdditionalRoutes)
            .set({
              status: 'ready',
              migrationSourceNodeId: null,
              migrationTargetNodeId: null,
              migrationPreviousSecureLinkId: null,
              migrationPreviousIncludePath: null,
              migrationPreviousRuntimeConfigGeneration: null,
              generation: current.generation + 1,
              updatedAt: new Date(),
            })
            .where(
              and(eq(proxyAdditionalRoutes.id, item.routeId), eq(proxyAdditionalRoutes.generation, item.generation))
            );
        } else {
          // Keep the claim durable while the target remains the only rendered
          // route. Reconciliation will retry source cleanup after reconnect.
          await this.db
            .update(proxyAdditionalRoutes)
            .set({ status: 'ready', updatedAt: new Date() })
            .where(
              and(eq(proxyAdditionalRoutes.id, item.routeId), eq(proxyAdditionalRoutes.generation, item.generation))
            );
        }
      }
    });
  }

  async rollbackNodeMigration(migration: AdditionalRouteNodeMigration): Promise<void> {
    await this.withHostLock(migration.hostId, async () => {
      await this.rollbackNodeMigrationLocked(migration);
    });
  }

  private async rollbackNodeMigrationLocked(migration: AdditionalRouteNodeMigration): Promise<void> {
    const host = await this.requireHost(migration.hostId);
    for (const item of [...migration.routes].reverse()) {
      const [current] = await this.db
        .select()
        .from(proxyAdditionalRoutes)
        .where(eq(proxyAdditionalRoutes.id, item.routeId))
        .limit(1);
      if (!current || current.migrationTargetNodeId === null) continue;
      if (current.generation !== item.generation || current.migrationTargetNodeId !== migration.targetNodeId) {
        throw new AppError(
          500,
          'ADDITIONAL_ROUTE_MIGRATION_OWNERSHIP_LOST',
          'Additional Route migration claim was lost'
        );
      }
      if (item.targetKind === 'pages') {
        if (this.pageRuntime) {
          await this.pageRuntime.deactivateRoute(migration.targetNodeId, item.routeId);
          await this.pageRuntime.removeRuntimeConfig(migration.targetNodeId, 'route', item.routeId);
        }
      } else if (item.stagedSecureLinkId && this.secureLinks) {
        await this.secureLinks.deleteManagedRouteBinding(host, item.stagedSecureLinkId);
      }
      await this.db
        .update(proxyAdditionalRoutes)
        .set({
          status: 'ready',
          secureLinkId: item.previousSecureLinkId,
          includePath: item.previousIncludePath,
          runtimeConfigGeneration: item.previousRuntimeConfigGeneration,
          migrationSourceNodeId: null,
          migrationTargetNodeId: null,
          migrationPreviousSecureLinkId: null,
          migrationPreviousIncludePath: null,
          migrationPreviousRuntimeConfigGeneration: null,
          generation: current.generation + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(proxyAdditionalRoutes.id, item.routeId), eq(proxyAdditionalRoutes.generation, item.generation)));
    }
  }

  async getRenderConfig(hostId: string): Promise<ProxyAdditionalRouteConfig[]> {
    const rows = await this.db.query.proxyAdditionalRoutes.findMany({
      where: and(
        eq(proxyAdditionalRoutes.proxyHostId, hostId),
        eq(proxyAdditionalRoutes.enabled, true),
        inArray(proxyAdditionalRoutes.status, ['ready', 'staging'])
      ),
      orderBy: (route, { asc }) => [asc(route.path)],
    });
    const configs: ProxyAdditionalRouteConfig[] = [];
    for (const row of rows) {
      if (row.status !== 'ready' && !row.migrationTargetNodeId) continue;
      if (isDockerKind(row.targetKind)) {
        const binding = row.secureLinkId
          ? await this.db.query.proxyAdditionalSecureLinks.findFirst({
              where: and(
                eq(proxyAdditionalSecureLinks.id, row.secureLinkId),
                eq(proxyAdditionalSecureLinks.purpose, 'additional_route'),
                eq(proxyAdditionalSecureLinks.status, 'active')
              ),
            })
          : await this.secureLinks?.getManagedRoute(row.id);
        if (!binding) continue;
        configs.push({
          id: row.id,
          path: row.path,
          targetKind: row.targetKind,
          forwardScheme: row.forwardScheme,
          forwardHost: '127.0.0.1',
          forwardPort: binding.listenerPort ?? 1,
          secureLinkUpstream: true,
          secureLinkSocketPath: `/run/gateway-secure-links/${binding.id}.sock`,
          stripPrefix: row.stripPrefix,
          websocketSupport: row.websocketSupport,
          requestBuffering: row.requestBuffering,
          responseBuffering: row.responseBuffering,
          connectTimeoutSeconds: row.connectTimeoutSeconds,
          readTimeoutSeconds: row.readTimeoutSeconds,
          sendTimeoutSeconds: row.sendTimeoutSeconds,
          advancedConfig: row.advancedConfig,
        });
      } else if (row.targetKind === 'pages') {
        if (!row.includePath || !row.runtimeConfigPath || !row.activeDeploymentId) continue;
        configs.push({
          id: row.id,
          path: row.path,
          targetKind: row.targetKind,
          forwardScheme: row.forwardScheme,
          forwardHost: null,
          forwardPort: null,
          pagesRouteIncludePath: row.includePath,
          pagesRuntimeConfigPath: row.runtimeConfigPath,
          stripPrefix: true,
          websocketSupport: false,
          requestBuffering: false,
          responseBuffering: false,
          connectTimeoutSeconds: 60,
          readTimeoutSeconds: 60,
          sendTimeoutSeconds: 60,
          advancedConfig: row.advancedConfig,
        });
      } else {
        configs.push({
          id: row.id,
          path: row.path,
          targetKind: 'manual',
          forwardScheme: row.forwardScheme,
          forwardHost: row.forwardHost,
          forwardPort: row.forwardPort,
          stripPrefix: row.stripPrefix,
          websocketSupport: row.websocketSupport,
          requestBuffering: row.requestBuffering,
          responseBuffering: row.responseBuffering,
          connectTimeoutSeconds: row.connectTimeoutSeconds,
          readTimeoutSeconds: row.readTimeoutSeconds,
          sendTimeoutSeconds: row.sendTimeoutSeconds,
          advancedConfig: row.advancedConfig,
        });
      }
    }
    return configs.sort((left, right) => right.path.length - left.path.length || left.path.localeCompare(right.path));
  }

  async reconcile(): Promise<boolean> {
    const pending = await this.db.query.proxyAdditionalRoutes.findMany({
      where: and(
        inArray(proxyAdditionalRoutes.status, ['staging', 'provisioning', 'cleanup_pending']),
        isNull(proxyAdditionalRoutes.migrationTargetNodeId)
      ),
    });
    const migrations = await this.db.query.proxyAdditionalRoutes.findMany({
      where: isNotNull(proxyAdditionalRoutes.migrationTargetNodeId),
    });
    let retry = false;
    for (const route of migrations) {
      try {
        const host = await this.requireHost(route.proxyHostId);
        if (!route.migrationSourceNodeId || !route.migrationTargetNodeId) continue;
        const migration: AdditionalRouteNodeMigration = {
          hostId: route.proxyHostId,
          sourceNodeId: route.migrationSourceNodeId,
          targetNodeId: route.migrationTargetNodeId,
          routeIds: [route.id],
          generation: route.generation,
          routes: [
            {
              routeId: route.id,
              targetKind: route.targetKind,
              generation: route.generation,
              previousSecureLinkId: route.migrationPreviousSecureLinkId,
              stagedSecureLinkId: isDockerKind(route.targetKind) ? route.secureLinkId : null,
              previousIncludePath: route.migrationPreviousIncludePath,
              previousRuntimeConfigGeneration: route.migrationPreviousRuntimeConfigGeneration ?? 0,
            },
          ],
        };
        if (host.nodeId === route.migrationTargetNodeId) {
          await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
          await this.commitNodeMigration(migration);
        } else if (host.nodeId === route.migrationSourceNodeId) {
          await this.rollbackNodeMigration(migration);
        } else {
          throw new AppError(
            409,
            'ADDITIONAL_ROUTE_MIGRATION_NODE_CHANGED',
            'Additional Route host node changed during migration'
          );
        }
      } catch (error) {
        retry = true;
        logger.warn('Additional Route migration reconciliation is still pending', { routeId: route.id, error });
      }
    }
    for (const route of pending) {
      try {
        const host = await this.requireHost(route.proxyHostId);
        if (route.status === 'cleanup_pending') {
          if (isDockerKind(route.targetKind)) await this.secureLinks?.deleteManagedRoute(host, route.id);
          if (route.targetKind === 'pages') await this.cleanupPages(route, host.nodeId);
          await this.db.delete(proxyAdditionalRoutes).where(eq(proxyAdditionalRoutes.id, route.id));
        } else {
          const target = this.normalizeTarget(route as unknown as Input, route);
          const provisioned = await this.provision(route, host, target);
          if (target.targetKind !== 'pages') await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
          this.emit(provisioned, 'reconciled');
        }
      } catch (error) {
        retry = true;
        await this.markFailed(route.id, error, null);
      }
    }
    return retry;
  }

  async updateRenamedContainerReferences(nodeId: string, oldName: string, newName: string): Promise<void> {
    await this.db
      .update(proxyAdditionalRoutes)
      .set({ dockerContainerName: newName, updatedAt: new Date() })
      .where(
        and(
          eq(proxyAdditionalRoutes.targetKind, 'docker_container'),
          eq(proxyAdditionalRoutes.dockerNodeId, nodeId),
          eq(proxyAdditionalRoutes.dockerContainerName, oldName)
        )
      );
  }

  async reconcileDockerTargets(force = false): Promise<boolean> {
    if (!this.secureLinks) return false;
    const routes = await this.db.query.proxyAdditionalRoutes.findMany({
      where: and(
        eq(proxyAdditionalRoutes.enabled, true),
        eq(proxyAdditionalRoutes.status, 'ready'),
        inArray(proxyAdditionalRoutes.targetKind, ['docker_container', 'docker_deployment']),
        isNull(proxyAdditionalRoutes.migrationTargetNodeId)
      ),
    });
    let retry = false;
    for (const route of routes) {
      try {
        await this.withHostLock(route.proxyHostId, async () => {
          const current = await this.db.query.proxyAdditionalRoutes.findFirst({
            where: and(
              eq(proxyAdditionalRoutes.id, route.id),
              eq(proxyAdditionalRoutes.enabled, true),
              eq(proxyAdditionalRoutes.status, 'ready')
            ),
          });
          if (!current || !isDockerKind(current.targetKind)) return;
          const host = await this.requireHost(current.proxyHostId);
          const binding = await this.secureLinks!.getManagedRoute(current.id);
          if (!force && binding && binding.status !== 'active') return;
          const ready = await this.secureLinks!.createManagedRoute(
            host,
            current.id,
            this.asSecureLinkInput(this.normalizeTarget(current as unknown as Input, current))
          );
          if (ready.status !== 'active') throw new Error(ready.lastError ?? 'Secure Link reconciliation failed');
        });
      } catch (error) {
        retry = true;
        logger.debug('Keeping last Additional Route Docker target until reconciliation succeeds', {
          routeId: route.id,
          error,
        });
      }
    }
    return retry;
  }

  async reconcileByTag(tagId: string): Promise<void> {
    const routes = await this.db.query.proxyAdditionalRoutes.findMany({
      where: and(eq(proxyAdditionalRoutes.pageTagId, tagId), eq(proxyAdditionalRoutes.targetKind, 'pages')),
    });
    for (const route of routes) await this.reconcilePagesRoute(route);
  }

  async reconcileByProject(projectId: string, tagId?: string | null): Promise<void> {
    const routes = await this.db.query.proxyAdditionalRoutes.findMany({
      where: and(eq(proxyAdditionalRoutes.pageProjectId, projectId), eq(proxyAdditionalRoutes.targetKind, 'pages')),
    });
    for (const route of routes) {
      if (tagId && route.pageTagId !== tagId) continue;
      await this.reconcilePagesRoute(route);
    }
  }

  /** PageTagPublicationAdapter boundary for route-owned Pages consumers. */
  async stageTagPublication(request: PageTagActivationRequest): Promise<Record<string, unknown>> {
    const rows = await this.db
      .select({ route: proxyAdditionalRoutes, nodeId: proxyHosts.nodeId })
      .from(proxyAdditionalRoutes)
      .innerJoin(proxyHosts, eq(proxyAdditionalRoutes.proxyHostId, proxyHosts.id))
      .where(and(eq(proxyAdditionalRoutes.pageTagId, request.tagId), eq(proxyAdditionalRoutes.targetKind, 'pages')));
    const progress: Array<Record<string, unknown>> = [];
    try {
      for (const row of rows.sort((left, right) => left.route.id.localeCompare(right.route.id))) {
        if (!row.nodeId || !this.pageRuntime || !this.pageRuntimeConfig || !row.route.pageProjectId) {
          throw new AppError(409, 'PAGES_ROUTE_NODE_MISSING', 'Additional Pages Route has no runtime node');
        }
        await this.withHostLock(row.route.proxyHostId, async () => {
          const [current] = await this.db
            .select()
            .from(proxyAdditionalRoutes)
            .where(eq(proxyAdditionalRoutes.id, row.route.id))
            .limit(1);
          if (!current || current.status !== 'ready' || !current.activeDeploymentId) return;
          const runtimeGeneration = current.runtimeConfigGeneration + 1;
          const effective = await this.pageRuntimeConfig!.getEffective(current.pageProjectId!, current.pageTagId!);
          try {
            const runtimeConfigPath = await this.pageRuntime!.publishRuntimeConfig(
              row.nodeId!,
              'route',
              current.id,
              runtimeGeneration,
              effective.value
            );
            const includePath = await this.pageRuntime!.activateRoute(row.nodeId!, current.id, request.deploymentId);
            const [updated] = await this.db
              .update(proxyAdditionalRoutes)
              .set({
                activeDeploymentId: request.deploymentId,
                includePath,
                runtimeConfigPath,
                runtimeConfigGeneration: runtimeGeneration,
                generation: current.generation + 1,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(proxyAdditionalRoutes.id, current.id),
                  eq(proxyAdditionalRoutes.generation, current.generation),
                  eq(proxyAdditionalRoutes.status, 'ready'),
                  eq(proxyAdditionalRoutes.activeDeploymentId, current.activeDeploymentId)
                )
              )
              .returning({ generation: proxyAdditionalRoutes.generation });
            if (!updated)
              throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Pages Route changed during publication');
            await this.hostRuntime?.reconcileAdditionalRouteHost(current.proxyHostId);
            progress.push({
              routeId: current.id,
              hostId: current.proxyHostId,
              nodeId: row.nodeId,
              fromDeploymentId: current.activeDeploymentId,
              fromIncludePath: current.includePath,
              toDeploymentId: request.deploymentId,
              fromRuntimeConfigGeneration: current.runtimeConfigGeneration,
              toRuntimeConfigGeneration: runtimeGeneration,
              generation: updated.generation,
            });
          } catch (error) {
            try {
              await this.restorePagesMaterialization(
                row.nodeId!,
                current.id,
                current.activeDeploymentId,
                current.runtimeConfigGeneration
              );
              await this.restorePagesRouteRow(current, request.deploymentId);
              await this.hostRuntime?.reconcileAdditionalRouteHost(current.proxyHostId);
            } catch (rollbackError) {
              await this.db
                .update(proxyAdditionalRoutes)
                .set({ status: 'failed', lastError: 'PAGES_ADDITIONAL_ROUTE_ROLLBACK_FAILED', updatedAt: new Date() })
                .where(eq(proxyAdditionalRoutes.id, current.id));
              throw new AggregateError([error, rollbackError], 'Additional Pages Route rollback failed');
            }
            throw error;
          }
        });
      }
      return { routes: progress };
    } catch (error) {
      await this.rollbackTagPublicationProgress(progress);
      throw error;
    }
  }

  async rollbackTagPublication(_request: PageTagActivationRequest, progress: Record<string, unknown>): Promise<void> {
    await this.rollbackTagPublicationProgress(
      (Array.isArray(progress.routes) ? progress.routes : []) as Array<Record<string, unknown>>
    );
  }

  private async rollbackTagPublicationProgress(progress: Array<Record<string, unknown>>): Promise<void> {
    for (const item of [...progress].reverse()) {
      const routeId = String(item.routeId ?? '');
      const hostId = String(item.hostId ?? '');
      const nodeId = String(item.nodeId ?? '');
      const fromDeploymentId = typeof item.fromDeploymentId === 'string' ? item.fromDeploymentId : null;
      const fromIncludePath = typeof item.fromIncludePath === 'string' ? item.fromIncludePath : null;
      const fromGeneration = Number(item.fromRuntimeConfigGeneration ?? 0);
      if (!routeId || !hostId || !nodeId || !this.pageRuntime) continue;
      try {
        if (fromDeploymentId) await this.pageRuntime.activateRoute(nodeId, routeId, fromDeploymentId);
        else await this.pageRuntime.deactivateRoute(nodeId, routeId);
        if (fromGeneration > 0) await this.pageRuntime.activateRuntimeConfig(nodeId, 'route', routeId, fromGeneration);
        else await this.pageRuntime.removeRuntimeConfig(nodeId, 'route', routeId);
        await this.db
          .update(proxyAdditionalRoutes)
          .set({
            activeDeploymentId: fromDeploymentId,
            includePath: fromIncludePath,
            runtimeConfigGeneration: fromGeneration,
            generation: Number(item.generation ?? 0) + 1,
            status: 'ready',
            updatedAt: new Date(),
          })
          .where(and(eq(proxyAdditionalRoutes.id, routeId), eq(proxyAdditionalRoutes.proxyHostId, hostId)));
        await this.hostRuntime?.reconcileAdditionalRouteHost(hostId);
      } catch (error) {
        await this.db
          .update(proxyAdditionalRoutes)
          .set({ status: 'failed', lastError: 'PAGES_ADDITIONAL_ROUTE_ROLLBACK_FAILED', updatedAt: new Date() })
          .where(eq(proxyAdditionalRoutes.id, routeId));
        logger.error('Additional Pages Route rollback failed', { routeId, error });
      }
    }
  }

  async publishRuntimeConfig(request: PageRuntimeConfigPublicationRequest): Promise<Record<string, unknown>> {
    if (!this.pageRuntime) return {};
    const rows = await this.db
      .select({ route: proxyAdditionalRoutes, nodeId: proxyHosts.nodeId })
      .from(proxyAdditionalRoutes)
      .innerJoin(proxyHosts, eq(proxyAdditionalRoutes.proxyHostId, proxyHosts.id))
      .where(
        and(
          eq(proxyAdditionalRoutes.targetKind, 'pages'),
          request.tagId
            ? eq(proxyAdditionalRoutes.pageTagId, request.tagId)
            : eq(proxyAdditionalRoutes.pageProjectId, request.projectId),
          eq(proxyAdditionalRoutes.status, 'ready')
        )
      );
    const applied: AdditionalRuntimeConfigProgress[] = [];
    try {
      for (const row of rows) {
        if (!row.nodeId)
          throw new AppError(409, 'PAGES_ROUTE_NODE_MISSING', 'Additional Pages Route has no runtime node');
        const current = row.route;
        if (request.tagId === null) {
          const effective = await this.pageRuntimeConfig?.getEffective(current.pageProjectId!, current.pageTagId!);
          if (effective?.tagId !== null) continue;
        }
        const from = current.runtimeConfigGeneration;
        const to = from + 1;
        const progress: AdditionalRuntimeConfigProgress = {
          routeId: current.id,
          hostId: current.proxyHostId,
          nodeId: row.nodeId,
          from,
          to,
          fromRouteGeneration: current.generation,
          toRouteGeneration: current.generation + 1,
        };
        try {
          const runtimeConfigPath = await this.pageRuntime.publishRuntimeConfig(
            row.nodeId,
            'route',
            current.id,
            to,
            request.value
          );
          const [updated] = await this.db
            .update(proxyAdditionalRoutes)
            .set({
              runtimeConfigPath,
              runtimeConfigGeneration: to,
              generation: current.generation + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(proxyAdditionalRoutes.id, current.id),
                eq(proxyAdditionalRoutes.generation, current.generation),
                eq(proxyAdditionalRoutes.status, 'ready')
              )
            )
            .returning({ id: proxyAdditionalRoutes.id });
          if (!updated)
            throw new AppError(
              409,
              'ADDITIONAL_ROUTE_CHANGED',
              'Additional Pages Route changed during runtime publication'
            );
          await this.hostRuntime?.reconcileAdditionalRouteHost(current.proxyHostId);
          applied.push(progress);
        } catch (error) {
          try {
            await this.restoreRuntimeConfigProgressItem(progress);
          } catch (rollbackError) {
            await this.db
              .update(proxyAdditionalRoutes)
              .set({ status: 'failed', lastError: 'PAGES_ADDITIONAL_RUNTIME_ROLLBACK_FAILED', updatedAt: new Date() })
              .where(eq(proxyAdditionalRoutes.id, current.id));
            throw new AggregateError([error, rollbackError], 'Additional Pages runtime-config rollback failed');
          }
          throw error;
        }
      }
      return { routes: applied };
    } catch (error) {
      await this.rollbackRuntimeConfigProgress(applied);
      throw error;
    }
  }

  async rollbackRuntimeConfig(
    _request: PageRuntimeConfigPublicationRequest,
    progress: Record<string, unknown>
  ): Promise<void> {
    await this.rollbackRuntimeConfigProgress(
      (Array.isArray(progress.routes) ? progress.routes : []) as AdditionalRuntimeConfigProgress[]
    );
  }

  private async rollbackRuntimeConfigProgress(applied: AdditionalRuntimeConfigProgress[]): Promise<void> {
    if (!this.pageRuntime) return;
    for (const item of [...applied].reverse()) {
      try {
        await this.restoreRuntimeConfigProgressItem(item);
      } catch {
        await this.db
          .update(proxyAdditionalRoutes)
          .set({ status: 'failed', lastError: 'PAGES_ADDITIONAL_RUNTIME_ROLLBACK_FAILED', updatedAt: new Date() })
          .where(eq(proxyAdditionalRoutes.id, item.routeId));
      }
    }
  }

  private async restoreRuntimeConfigProgressItem(item: AdditionalRuntimeConfigProgress): Promise<void> {
    if (!this.pageRuntime) return;
    if (item.from > 0) await this.pageRuntime.activateRuntimeConfig(item.nodeId, 'route', item.routeId, item.from);
    else await this.pageRuntime.removeRuntimeConfig(item.nodeId, 'route', item.routeId);

    const [current] = await this.db
      .select()
      .from(proxyAdditionalRoutes)
      .where(eq(proxyAdditionalRoutes.id, item.routeId))
      .limit(1);
    if (
      !current ||
      (current.generation === item.fromRouteGeneration && current.runtimeConfigGeneration === item.from)
    ) {
      return;
    }
    if (
      current.generation !== item.toRouteGeneration ||
      current.runtimeConfigGeneration !== item.to ||
      current.status !== 'ready'
    ) {
      throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Pages Route changed during rollback');
    }
    const [restored] = await this.db
      .update(proxyAdditionalRoutes)
      .set({ runtimeConfigGeneration: item.from, generation: current.generation + 1, updatedAt: new Date() })
      .where(
        and(
          eq(proxyAdditionalRoutes.id, item.routeId),
          eq(proxyAdditionalRoutes.generation, item.toRouteGeneration),
          eq(proxyAdditionalRoutes.runtimeConfigGeneration, item.to),
          eq(proxyAdditionalRoutes.status, 'ready')
        )
      )
      .returning({ id: proxyAdditionalRoutes.id });
    if (!restored) throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Pages Route rollback was lost');
    await this.hostRuntime?.reconcileAdditionalRouteHost(item.hostId);
  }

  private async reconcilePagesRoute(route: AdditionalRouteRow): Promise<void> {
    if (!route.pageProjectId || !route.pageTagId || route.status !== 'ready') return;
    const host = await this.requireHost(route.proxyHostId);
    const target = this.normalizeTarget(route as unknown as Input, route);
    try {
      await this.withHostLock(route.proxyHostId, async () => {
        const deployment = await this.resolvePageDeployment(target.pageProjectId!, target.pageTagId!);
        if (deployment.id === route.activeDeploymentId) return;
        const [staged] = await this.db
          .update(proxyAdditionalRoutes)
          .set({ status: 'staging', generation: route.generation + 1, updatedAt: new Date() })
          .where(
            and(
              eq(proxyAdditionalRoutes.id, route.id),
              eq(proxyAdditionalRoutes.generation, route.generation),
              eq(proxyAdditionalRoutes.status, 'ready')
            )
          )
          .returning();
        if (!staged) return;
        await this.publishAndActivatePages(staged, host, deployment.id);
      });
    } catch (error) {
      await this.markFailed(route.id, error, null);
    }
  }

  private async provision(
    route: AdditionalRouteRow,
    host: ProxyHostRow,
    target: NormalizedTarget
  ): Promise<AdditionalRouteRow> {
    if (!route.enabled) return route;
    if (isDockerKind(target.targetKind)) {
      if (!this.secureLinks) throw new AppError(503, 'SECURE_LINK_UNAVAILABLE', 'Proxy Secure Links are unavailable');
      const binding = await this.secureLinks.createManagedRoute(host, route.id, this.asSecureLinkInput(target));
      if (binding.status !== 'active') {
        return (
          (await this.markFailed(route.id, new Error(binding.lastError ?? 'Secure Link provisioning failed'), null)) ??
          route
        );
      }
      const [ready] = await this.db
        .update(proxyAdditionalRoutes)
        .set({
          secureLinkId: binding.id,
          activeDeploymentId: null,
          includePath: null,
          runtimeConfigPath: null,
          runtimeConfigGeneration: 0,
          status: 'ready',
          lastError: null,
          generation: route.generation + 1,
          updatedAt: new Date(),
        })
        .where(eq(proxyAdditionalRoutes.id, route.id))
        .returning();
      return ready ?? route;
    }
    if (target.targetKind === 'pages') {
      const deployment = await this.resolvePageDeployment(target.pageProjectId!, target.pageTagId!);
      return this.publishAndActivatePages(route, host, deployment.id);
    }
    const [ready] = await this.db
      .update(proxyAdditionalRoutes)
      .set({
        secureLinkId: null,
        activeDeploymentId: null,
        includePath: null,
        runtimeConfigPath: null,
        runtimeConfigGeneration: 0,
        status: 'ready',
        lastError: null,
        generation: route.generation + 1,
        updatedAt: new Date(),
      })
      .where(eq(proxyAdditionalRoutes.id, route.id))
      .returning();
    return ready ?? route;
  }

  private async publishAndActivatePages(
    route: AdditionalRouteRow,
    host: ProxyHostRow,
    deploymentId: string
  ): Promise<AdditionalRouteRow> {
    if (!host.nodeId || !this.pageRuntime || !this.pageRuntimeConfig || !route.pageProjectId || !route.pageTagId) {
      throw new AppError(503, 'PAGES_ROUTE_UNAVAILABLE', 'Pages Route runtime is unavailable');
    }
    const effective = await this.pageRuntimeConfig.getEffective(route.pageProjectId, route.pageTagId);
    const generation = route.runtimeConfigGeneration + 1;
    try {
      const runtimeConfigPath = await this.pageRuntime.publishRuntimeConfig(
        host.nodeId,
        'route',
        route.id,
        generation,
        effective.value
      );
      const includePath = await this.pageRuntime.activateRoute(host.nodeId, route.id, deploymentId);
      const [ready] = await this.db
        .update(proxyAdditionalRoutes)
        .set({
          secureLinkId: null,
          activeDeploymentId: deploymentId,
          includePath,
          runtimeConfigPath,
          runtimeConfigGeneration: generation,
          status: 'ready',
          lastError: null,
          generation: route.generation + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(proxyAdditionalRoutes.id, route.id), eq(proxyAdditionalRoutes.generation, route.generation)))
        .returning();
      if (!ready) throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Route changed concurrently');
      await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
      return ready;
    } catch (error) {
      try {
        await this.restorePagesMaterialization(
          host.nodeId,
          route.id,
          route.activeDeploymentId,
          route.runtimeConfigGeneration
        );
        await this.restorePagesRouteRow(route, deploymentId);
        await this.hostRuntime?.reconcileAdditionalRouteHost(host.id);
      } catch (rollbackError) {
        await this.db
          .update(proxyAdditionalRoutes)
          .set({ status: 'failed', lastError: 'PAGES_ADDITIONAL_ROUTE_ROLLBACK_FAILED', updatedAt: new Date() })
          .where(eq(proxyAdditionalRoutes.id, route.id));
        throw new AggregateError([error, rollbackError], 'Additional Pages Route rollback failed');
      }
      throw error;
    }
  }

  private async cleanupPages(route: Pick<AdditionalRouteRow, 'id'>, nodeId: string | null): Promise<void> {
    if (!nodeId || !this.pageRuntime) return;
    await this.pageRuntime.deactivateRoute(nodeId, route.id);
    await this.pageRuntime.removeRuntimeConfig(nodeId, 'route', route.id);
  }

  private async restorePagesMaterialization(
    nodeId: string,
    routeId: string,
    deploymentId: string | null,
    runtimeConfigGeneration: number
  ): Promise<void> {
    if (deploymentId) await this.pageRuntime!.activateRoute(nodeId, routeId, deploymentId);
    else await this.pageRuntime!.deactivateRoute(nodeId, routeId);
    if (runtimeConfigGeneration > 0) {
      await this.pageRuntime!.activateRuntimeConfig(nodeId, 'route', routeId, runtimeConfigGeneration);
    } else {
      await this.pageRuntime!.removeRuntimeConfig(nodeId, 'route', routeId);
    }
  }

  private async restorePagesRouteRow(previous: AdditionalRouteRow, expectedDeploymentId: string): Promise<void> {
    const [current] = await this.db
      .select()
      .from(proxyAdditionalRoutes)
      .where(eq(proxyAdditionalRoutes.id, previous.id))
      .limit(1);
    if (!current || current.generation === previous.generation) return;
    if (current.generation !== previous.generation + 1 || current.activeDeploymentId !== expectedDeploymentId) {
      throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Pages Route changed during rollback');
    }
    const [restored] = await this.db
      .update(proxyAdditionalRoutes)
      .set({
        secureLinkId: previous.secureLinkId,
        activeDeploymentId: previous.activeDeploymentId,
        includePath: previous.includePath,
        runtimeConfigPath: previous.runtimeConfigPath,
        runtimeConfigGeneration: previous.runtimeConfigGeneration,
        status: previous.status,
        lastError: null,
        generation: current.generation + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(proxyAdditionalRoutes.id, previous.id), eq(proxyAdditionalRoutes.generation, current.generation)))
      .returning({ id: proxyAdditionalRoutes.id });
    if (!restored) throw new AppError(409, 'ADDITIONAL_ROUTE_CHANGED', 'Additional Pages Route rollback was lost');
  }

  private async resolvePageDeployment(projectId: string, tagId: string) {
    const [row] = await this.db
      .select({ deployment: pageDeployments, generation: pageTags.generation })
      .from(pageTags)
      .innerJoin(pageDeployments, eq(pageTags.deploymentId, pageDeployments.id))
      .where(and(eq(pageTags.id, tagId), eq(pageTags.projectId, projectId), eq(pageDeployments.status, 'ready')))
      .limit(1);
    if (!row) throw new AppError(409, 'PAGES_TAG_NOT_DEPLOYED', 'Select a Tag with a ready Deployment');
    return row.deployment;
  }

  private routeOptions(input: Input, target: NormalizedTarget) {
    const pages = target.targetKind === 'pages';
    const boundedTimeout = (key: string): number => {
      const value = Number(input[key] ?? 60);
      if (!Number.isInteger(value) || value < 1 || value > 3600) {
        throw new AppError(400, 'INVALID_ROUTE_TIMEOUT', `${key} must be between 1 and 3600 seconds`);
      }
      return value;
    };
    return {
      stripPrefix: pages ? true : Boolean(input.stripPrefix ?? false),
      websocketSupport: pages ? false : Boolean(input.websocketSupport ?? false),
      requestBuffering: pages ? false : input.requestBuffering !== false,
      responseBuffering: pages ? false : input.responseBuffering !== false,
      connectTimeoutSeconds: pages ? 60 : boundedTimeout('connectTimeoutSeconds'),
      readTimeoutSeconds: pages ? 60 : boundedTimeout('readTimeoutSeconds'),
      sendTimeoutSeconds: pages ? 60 : boundedTimeout('sendTimeoutSeconds'),
    };
  }

  private targetChanged(existing: AdditionalRouteRow, target: NormalizedTarget): boolean {
    return (
      existing.targetKind !== target.targetKind ||
      existing.forwardHost !== target.forwardHost ||
      existing.forwardPort !== target.forwardPort ||
      existing.forwardScheme !== target.forwardScheme ||
      existing.dockerNodeId !== target.dockerNodeId ||
      existing.dockerContainerName !== target.dockerContainerName ||
      existing.dockerDeploymentId !== target.dockerDeploymentId ||
      existing.dockerContainerPort !== target.dockerContainerPort ||
      existing.dockerHostPort !== target.dockerHostPort ||
      existing.dockerProtocol !== target.dockerProtocol ||
      existing.pageProjectId !== target.pageProjectId ||
      existing.pageTagId !== target.pageTagId
    );
  }

  private async markFailed(
    routeId: string,
    error: unknown,
    updatedById: string | null
  ): Promise<AdditionalRouteRow | undefined> {
    const [failed] = await this.db
      .update(proxyAdditionalRoutes)
      .set({
        status: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
        ...(updatedById ? { updatedById } : {}),
        updatedAt: new Date(),
      })
      .where(eq(proxyAdditionalRoutes.id, routeId))
      .returning();
    if (failed) this.emit(failed, 'failed');
    return failed;
  }

  private emit(route: Pick<AdditionalRouteRow, 'id' | 'proxyHostId' | 'path' | 'status'>, action: string): void {
    const payload = { id: route.proxyHostId, routeId: route.id, path: route.path, action, status: route.status };
    this.eventBus?.publish('proxy.additional-route.changed', payload);
    this.eventBus?.publish('proxy.host.changed', payload);
  }
}
