import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  nodes,
  pageDeployments,
  pageRouteTargets,
  pageTagActivations,
  pageTags,
  proxyHosts,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CreateProxyHostInput } from '@/modules/proxy/proxy.schemas.js';
import { hasRequiredNginxPagesCapabilities } from '../profile/page-node-capability.js';
import { type PageNodeRuntimeService, validatePageRouteIncludePath } from '../runtime/page-node-runtime.service.js';
import type {
  PageRuntimeConfigPublicationAdapter,
  PageRuntimeConfigPublicationRequest,
  PageRuntimeConfigService,
} from '../runtime-config/page-runtime-config.service.js';
import type { PageTagPublicationAdapter } from '../tags/page-publication.service.js';
import type { PageTagActivationRequest } from '../tags/page-tag.service.js';

export interface AdditionalPageRoutePublicationAdapter {
  stageTagPublication(request: PageTagActivationRequest): Promise<Record<string, unknown>>;
  rollbackTagPublication?(request: PageTagActivationRequest, progress: Record<string, unknown>): Promise<void>;
  publishRuntimeConfig?(request: PageRuntimeConfigPublicationRequest): Promise<Record<string, unknown>>;
  rollbackRuntimeConfig?(
    request: PageRuntimeConfigPublicationRequest,
    progress: Record<string, unknown>
  ): Promise<void>;
}

interface RouteProgress {
  routeId: string;
  nodeId: string;
  fromDeploymentId: string | null;
  toDeploymentId: string;
  fromStatus: 'ready' | 'failed' | 'pending';
  fromRuntimeConfigGeneration: number;
  toRuntimeConfigGeneration: number;
  claimedGeneration: number;
  generation: number;
}

interface RouteRuntimeConfigProgress {
  targetId: string;
  routeId: string;
  nodeId: string;
  fromGeneration: number;
  toGeneration: number;
  targetGeneration: number;
}

const PAGE_ROUTE_CREATE_CLEANUP_PENDING = 'PAGES_ROUTE_CREATE_CLEANUP_PENDING';
const PAGE_ROUTE_REMOVAL_CLEANUP_CLAIMED = 'PAGES_ROUTE_REMOVAL_CLEANUP_CLAIMED';
const PAGE_ROUTE_REMOVAL_CLEANUP_PENDING = 'PAGES_ROUTE_REMOVAL_CLEANUP_PENDING';
const PAGE_ROUTE_REMOVAL_CLEANUP_CONFLICT = 'PAGES_ROUTE_REMOVAL_CLEANUP_CONFLICT';

export interface PageRouteNodeMigration {
  routeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  deploymentId: string;
  previousIncludePath: string | null;
  targetIncludePath: string;
  generation: number;
}

export class PageRouteService implements PageTagPublicationAdapter, PageRuntimeConfigPublicationAdapter {
  private readonly routeLocks = new Map<string, Promise<void>>();
  private additionalRoutes?: AdditionalPageRoutePublicationAdapter;

  constructor(
    private readonly db: DrizzleClient,
    private readonly runtime: PageNodeRuntimeService,
    private readonly auditService: AuditService,
    private readonly runtimeConfig: PageRuntimeConfigService
  ) {}

  setAdditionalRoutePublicationAdapter(adapter: AdditionalPageRoutePublicationAdapter): void {
    this.additionalRoutes = adapter;
  }

  async validateCreate(input: CreateProxyHostInput): Promise<{ projectId: string; tagId: string }> {
    if (input.upstreamKind !== 'pages' || !input.pageProjectId || !input.pageTagId) {
      throw new AppError(400, 'PAGES_ROUTE_TARGET_REQUIRED', 'Select a Page Project and Tag');
    }
    if (input.type !== 'proxy' || input.rawConfigEnabled || input.nginxTemplateId) {
      throw new AppError(400, 'PAGES_ROUTE_SETTINGS_INVALID', 'Pages Routes require the managed proxy template');
    }
    await this.assertPagesRouteNode(input.nodeId);
    await this.targetDeployment(input.pageProjectId, input.pageTagId);
    await this.runtime.preflight(input.nodeId, 0);
    return { projectId: input.pageProjectId, tagId: input.pageTagId };
  }

  async activateNewHost(proxyHostId: string, nodeId: string, projectId: string, tagId: string): Promise<void> {
    await this.withRouteLock(proxyHostId, async () => {
      const snapshot = await this.targetSnapshot(projectId, tagId);
      await this.assertTagActivationIdle(tagId);
      const deployment = snapshot.deployment;
      const config = await this.runtimeConfig.getEffective(projectId, tagId);

      // Claim ownership before contacting the daemon. A timeout can happen
      // after the daemon accepts a mutation, so the target row must survive
      // until the binding is confirmed gone.
      await this.db.insert(pageRouteTargets).values({
        proxyHostId,
        projectId,
        tagId,
        activeDeploymentId: deployment.id,
        includePath: null,
        status: 'staging',
        generation: 1,
        runtimeConfigGeneration: 1,
      });

      let runtimeMutationStarted = false;
      try {
        // The daemon owns both the route replica and its runtime-config binding.
        runtimeMutationStarted = true;
        await this.runtime.publishRuntimeConfig(nodeId, 'route', proxyHostId, 1, config.value);
        const includePath = await this.runtime.activateRoute(nodeId, proxyHostId, deployment.id);
        await this.db.transaction(async (tx) => {
          // Lock the Tag while validating its snapshot and publishing the Route.
          // An activation that starts after this transaction commits will observe
          // the ready Route; one that won first makes this snapshot invalid.
          const [currentTag] = await tx
            .select({ deploymentId: pageTags.deploymentId, generation: pageTags.generation })
            .from(pageTags)
            .where(and(eq(pageTags.id, tagId), eq(pageTags.projectId, projectId)))
            .limit(1)
            .for('update');
          if (
            !currentTag ||
            currentTag.deploymentId !== deployment.id ||
            currentTag.generation !== snapshot.generation
          ) {
            throw new AppError(409, 'PAGES_TAG_CHANGED', 'Pages Tag changed while the Route was being created');
          }
          // If cleanup marker persistence later fails, the retained row is still
          // non-ready and therefore cannot serve the stale Route materialization.
          const [persisted] = await tx
            .update(pageRouteTargets)
            .set({ includePath, status: 'ready', lastErrorCode: null, updatedAt: new Date() })
            .where(
              and(
                eq(pageRouteTargets.proxyHostId, proxyHostId),
                eq(pageRouteTargets.generation, 1),
                eq(pageRouteTargets.status, 'staging')
              )
            )
            .returning({ id: pageRouteTargets.id });
          if (!persisted) {
            throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route changed concurrently');
          }
        });
      } catch (error) {
        let cleanupError: unknown;
        if (runtimeMutationStarted) {
          cleanupError = await this.cleanupRuntimeBinding(nodeId, proxyHostId);
        }
        if (cleanupError) {
          await this.markCreateCleanupPending(proxyHostId, 1);
          throw error;
        }
        try {
          await this.db.delete(pageRouteTargets).where(eq(pageRouteTargets.proxyHostId, proxyHostId));
        } catch {
          await this.markCreateCleanupPending(proxyHostId, 1);
        }
        throw error;
      }
    });
  }

  async getIncludePath(proxyHostId: string): Promise<string> {
    const [target] = await this.db
      .select({ includePath: pageRouteTargets.includePath, status: pageRouteTargets.status })
      .from(pageRouteTargets)
      .where(eq(pageRouteTargets.proxyHostId, proxyHostId))
      .limit(1);
    if (!target?.includePath || target.status !== 'ready') {
      throw new AppError(409, 'PAGES_ROUTE_NOT_READY', 'Pages Route target is not ready');
    }
    return validatePageRouteIncludePath(proxyHostId, target.includePath);
  }

  async getTarget(proxyHostId: string) {
    const [row] = await this.db
      .select({
        projectId: pageRouteTargets.projectId,
        tagId: pageRouteTargets.tagId,
        deploymentId: pageRouteTargets.activeDeploymentId,
        status: pageRouteTargets.status,
        generation: pageRouteTargets.generation,
        lastErrorCode: pageRouteTargets.lastErrorCode,
      })
      .from(pageRouteTargets)
      .where(eq(pageRouteTargets.proxyHostId, proxyHostId))
      .limit(1);
    return row ?? null;
  }

  async reconcile(): Promise<void> {
    const routes = await this.db
      .select({ target: pageRouteTargets, nodeId: proxyHosts.nodeId })
      .from(pageRouteTargets)
      .innerJoin(proxyHosts, eq(pageRouteTargets.proxyHostId, proxyHosts.id))
      .where(eq(proxyHosts.upstreamKind, 'pages'));
    for (const route of routes) {
      if (!route.nodeId) continue;
      if (this.hasDeferredCleanupClaim(route.target)) {
        await this.withRouteLock(route.target.proxyHostId, async () => {
          const [current] = await this.db
            .select()
            .from(pageRouteTargets)
            .where(eq(pageRouteTargets.id, route.target.id))
            .limit(1);
          if (!current || !this.hasDeferredCleanupClaim(current)) return;
          const claimed = await this.claimRouteRemoval(current);
          if (!claimed) return;
          const cleanupError = await this.cleanupRuntimeBinding(route.nodeId!, current.proxyHostId);
          if (cleanupError) {
            await this.markRouteRemovalPending(current.id, claimed.generation);
            return;
          }
          try {
            // The proxy-host delete owns target deletion through the database
            // cascade. It is valid only while the retained host is still the
            // disabled Pages host created for this failed request.
            if (await this.deleteDisabledCleanupHost(current.proxyHostId)) return;
          } catch {
            await this.markRouteRemovalPending(current.id, claimed.generation);
            return;
          }
          const [host] = await this.db
            .select({ enabled: proxyHosts.enabled, upstreamKind: proxyHosts.upstreamKind })
            .from(proxyHosts)
            .where(eq(proxyHosts.id, current.proxyHostId))
            .limit(1);
          if (!host) return;
          if (host.enabled || host.upstreamKind !== 'pages') {
            await this.markRouteRemovalConflict(current.id, claimed.generation);
            return;
          }
          await this.markRouteRemovalPending(current.id, claimed.generation);
        });
        continue;
      }
      if (!route.target.activeDeploymentId || route.target.status !== 'ready') continue;
      await this.withRouteLock(route.target.proxyHostId, async () => {
        const [current] = await this.db
          .select()
          .from(pageRouteTargets)
          .where(eq(pageRouteTargets.id, route.target.id))
          .limit(1);
        if (!current?.activeDeploymentId || current.status !== 'ready') return;

        const [claimed] = await this.db
          .update(pageRouteTargets)
          .set({ status: 'staging', generation: current.generation + 1, lastErrorCode: null, updatedAt: new Date() })
          .where(
            and(
              eq(pageRouteTargets.id, current.id),
              eq(pageRouteTargets.generation, current.generation),
              eq(pageRouteTargets.status, current.status),
              eq(pageRouteTargets.activeDeploymentId, current.activeDeploymentId)
            )
          )
          .returning({ generation: pageRouteTargets.generation });
        if (!claimed) return;

        const previousRuntimeConfigGeneration = current.runtimeConfigGeneration;
        const nextRuntimeConfigGeneration = previousRuntimeConfigGeneration + 1;
        try {
          const config = await this.runtimeConfig.getEffective(current.projectId, current.tagId);
          await this.runtime.publishRuntimeConfig(
            route.nodeId!,
            'route',
            current.proxyHostId,
            nextRuntimeConfigGeneration,
            config.value
          );
          const includePath = await this.runtime.activateRoute(
            route.nodeId!,
            current.proxyHostId,
            current.activeDeploymentId
          );
          const [updated] = await this.db
            .update(pageRouteTargets)
            .set({
              runtimeConfigGeneration: nextRuntimeConfigGeneration,
              includePath,
              status: 'ready',
              generation: claimed.generation + 1,
              lastErrorCode: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(pageRouteTargets.id, current.id),
                eq(pageRouteTargets.generation, claimed.generation),
                eq(pageRouteTargets.activeDeploymentId, current.activeDeploymentId),
                eq(pageRouteTargets.status, 'staging')
              )
            )
            .returning({ id: pageRouteTargets.id });
          if (!updated) throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route changed concurrently');
        } catch (error) {
          let rollbackFailed = false;
          try {
            await this.runtime.activateRoute(route.nodeId!, current.proxyHostId, current.activeDeploymentId);
          } catch {
            rollbackFailed = true;
          }
          try {
            await this.restoreRouteRuntimeConfig(route.nodeId!, current.proxyHostId, previousRuntimeConfigGeneration);
          } catch {
            rollbackFailed = true;
          }
          const [restored] = await this.db
            .update(pageRouteTargets)
            .set({
              status: 'ready',
              generation: claimed.generation + 1,
              runtimeConfigGeneration: previousRuntimeConfigGeneration,
              includePath: current.includePath,
              lastErrorCode: rollbackFailed
                ? 'PAGES_ROUTE_RECONCILIATION_ROLLBACK_FAILED'
                : error instanceof AppError
                  ? error.code
                  : 'PAGES_ROUTE_RECONCILIATION_FAILED',
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(pageRouteTargets.id, current.id),
                eq(pageRouteTargets.generation, claimed.generation),
                eq(pageRouteTargets.status, 'staging'),
                eq(pageRouteTargets.activeDeploymentId, current.activeDeploymentId)
              )
            )
            .returning({ id: pageRouteTargets.id });
          if (!restored || rollbackFailed) {
            await this.db
              .update(pageRouteTargets)
              .set({
                status: 'failed',
                lastErrorCode: 'PAGES_ROUTE_RECONCILIATION_ROLLBACK_FAILED',
                updatedAt: new Date(),
              })
              .where(and(eq(pageRouteTargets.id, current.id), eq(pageRouteTargets.generation, claimed.generation)));
          }
        }
      });
    }
  }

  async removeHost(proxyHostId: string, nodeId: string | null, abandonOfflineNode = false): Promise<void> {
    await this.withRouteLock(proxyHostId, async () => {
      const [target] = await this.db
        .select()
        .from(pageRouteTargets)
        .where(eq(pageRouteTargets.proxyHostId, proxyHostId))
        .limit(1);
      if (!target) return;
      if (!['ready', 'failed'].includes(target.status)) {
        throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route is being changed concurrently');
      }

      // The compare-and-swap claim coordinates separate backend processes
      // before either one asks the daemon to remove route state.
      const claimed = await this.claimRouteRemoval(target);
      if (!claimed) throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route changed concurrently');

      if (nodeId && !abandonOfflineNode) {
        const cleanupError = await this.cleanupRuntimeBinding(nodeId, proxyHostId);
        if (cleanupError) {
          await this.markRouteRemovalPending(target.id, claimed.generation);
          throw cleanupError;
        }
      }
      // Keep the durable claim until ProxyService deletes the proxy host. The
      // foreign-key cascade then removes this target atomically with its host.
    });
  }

  async publishRuntimeConfig(request: PageRuntimeConfigPublicationRequest): Promise<void> {
    const routeProgress = await this.publishRouteRuntimeConfig(request);
    let additionalProgress: Record<string, unknown> | undefined;
    try {
      if (this.additionalRoutes?.publishRuntimeConfig) {
        const progress = await this.additionalRoutes.publishRuntimeConfig(request);
        if (progress) additionalProgress = progress;
      }
      if (request.tagId === null) {
        await this.runtime.publishPreviewRuntimeConfig(request.projectId, request.value);
      }
    } catch (error) {
      let rollbackError: unknown;
      if (additionalProgress && this.additionalRoutes?.rollbackRuntimeConfig) {
        try {
          await this.additionalRoutes.rollbackRuntimeConfig(request, additionalProgress);
        } catch (additionalRollbackError) {
          rollbackError = additionalRollbackError;
        }
      }
      try {
        await this.rollbackRouteRuntimeConfig(routeProgress);
      } catch (routeRollbackError) {
        rollbackError = rollbackError
          ? new AggregateError([rollbackError, routeRollbackError], 'Pages runtime config rollback failed')
          : routeRollbackError;
      }
      if (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Pages runtime config publication and rollback failed');
      }
      throw error;
    }
  }

  private async publishRouteRuntimeConfig(
    request: PageRuntimeConfigPublicationRequest
  ): Promise<RouteRuntimeConfigProgress[]> {
    const routes = await this.db
      .select({ target: pageRouteTargets, nodeId: proxyHosts.nodeId })
      .from(pageRouteTargets)
      .innerJoin(proxyHosts, eq(pageRouteTargets.proxyHostId, proxyHosts.id))
      .where(
        and(
          request.tagId ? eq(pageRouteTargets.tagId, request.tagId) : eq(pageRouteTargets.projectId, request.projectId),
          eq(proxyHosts.upstreamKind, 'pages')
        )
      );
    const applied: RouteRuntimeConfigProgress[] = [];
    try {
      for (const route of routes.sort((left, right) =>
        left.target.proxyHostId.localeCompare(right.target.proxyHostId)
      )) {
        if (!route.nodeId) throw new AppError(409, 'PAGES_ROUTE_NODE_MISSING', 'Pages Route has no Nginx node');
        await this.withRouteLock(route.target.proxyHostId, async () => {
          const [current] = await this.db
            .select()
            .from(pageRouteTargets)
            .where(eq(pageRouteTargets.id, route.target.id))
            .limit(1);
          if (!current || current.status !== 'ready') return;
          if (request.tagId ? current.tagId !== request.tagId : current.projectId !== request.projectId) return;
          const effective = await this.runtimeConfig.getEffective(current.projectId, current.tagId);
          if (request.tagId === null && effective.tagId !== null) return;

          const [claimed] = await this.db
            .update(pageRouteTargets)
            .set({ status: 'staging', generation: current.generation + 1, lastErrorCode: null, updatedAt: new Date() })
            .where(
              and(
                eq(pageRouteTargets.id, current.id),
                eq(pageRouteTargets.generation, current.generation),
                eq(pageRouteTargets.runtimeConfigGeneration, current.runtimeConfigGeneration),
                eq(pageRouteTargets.status, 'ready')
              )
            )
            .returning({ generation: pageRouteTargets.generation });
          if (!claimed) throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route changed concurrently');

          const nextConfigGeneration = current.runtimeConfigGeneration + 1;
          try {
            await this.runtime.publishRuntimeConfig(
              route.nodeId!,
              'route',
              current.proxyHostId,
              nextConfigGeneration,
              effective.value
            );
            const finalGeneration = claimed.generation + 1;
            const [updated] = await this.db
              .update(pageRouteTargets)
              .set({
                runtimeConfigGeneration: nextConfigGeneration,
                status: 'ready',
                generation: finalGeneration,
                lastErrorCode: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(pageRouteTargets.id, current.id),
                  eq(pageRouteTargets.generation, claimed.generation),
                  eq(pageRouteTargets.runtimeConfigGeneration, current.runtimeConfigGeneration),
                  eq(pageRouteTargets.status, 'staging')
                )
              )
              .returning({ id: pageRouteTargets.id });
            if (!updated) throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route changed concurrently');
            applied.push({
              targetId: current.id,
              routeId: current.proxyHostId,
              nodeId: route.nodeId!,
              fromGeneration: current.runtimeConfigGeneration,
              toGeneration: nextConfigGeneration,
              targetGeneration: finalGeneration,
            });
          } catch (error) {
            let rollbackFailed = false;
            try {
              await this.restoreRouteRuntimeConfig(route.nodeId!, current.proxyHostId, current.runtimeConfigGeneration);
            } catch {
              rollbackFailed = true;
            }
            const [restored] = await this.db
              .update(pageRouteTargets)
              .set({
                status: 'ready',
                generation: claimed.generation + 1,
                runtimeConfigGeneration: current.runtimeConfigGeneration,
                lastErrorCode: rollbackFailed
                  ? 'PAGES_RUNTIME_CONFIG_ROLLBACK_FAILED'
                  : 'PAGES_RUNTIME_CONFIG_PUBLICATION_FAILED',
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(pageRouteTargets.id, current.id),
                  eq(pageRouteTargets.generation, claimed.generation),
                  eq(pageRouteTargets.status, 'staging')
                )
              )
              .returning({ id: pageRouteTargets.id });
            if (!restored || rollbackFailed) {
              await this.db
                .update(pageRouteTargets)
                .set({ status: 'failed', lastErrorCode: 'PAGES_RUNTIME_CONFIG_ROLLBACK_FAILED', updatedAt: new Date() })
                .where(and(eq(pageRouteTargets.id, current.id), eq(pageRouteTargets.generation, claimed.generation)));
              if (rollbackFailed) {
                throw new AppError(
                  500,
                  'PAGES_RUNTIME_CONFIG_ROLLBACK_FAILED',
                  'Runtime configuration rollback failed'
                );
              }
            }
            throw error;
          }
        });
      }
      return applied;
    } catch (error) {
      await this.rollbackRouteRuntimeConfig(applied);
      throw error;
    }
  }

  private async rollbackRouteRuntimeConfig(progress: RouteRuntimeConfigProgress[]): Promise<void> {
    for (const item of [...progress].reverse()) {
      await this.withRouteLock(item.routeId, async () => {
        const [current] = await this.db
          .select()
          .from(pageRouteTargets)
          .where(eq(pageRouteTargets.id, item.targetId))
          .limit(1);
        if (
          !current ||
          current.runtimeConfigGeneration !== item.toGeneration ||
          current.generation !== item.targetGeneration ||
          current.status !== 'ready'
        ) {
          return;
        }
        await this.restoreRouteRuntimeConfig(item.nodeId, item.routeId, item.fromGeneration);
        await this.db
          .update(pageRouteTargets)
          .set({
            runtimeConfigGeneration: item.fromGeneration,
            generation: current.generation + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(pageRouteTargets.id, item.targetId),
              eq(pageRouteTargets.generation, item.targetGeneration),
              eq(pageRouteTargets.runtimeConfigGeneration, item.toGeneration),
              eq(pageRouteTargets.status, 'ready')
            )
          );
      });
    }
  }

  private async restoreRouteRuntimeConfig(nodeId: string, routeId: string, generation: number): Promise<void> {
    if (generation > 0) {
      await this.runtime.activateRuntimeConfig(nodeId, 'route', routeId, generation);
    } else {
      await this.runtime.removeRuntimeConfig(nodeId, 'route', routeId);
    }
  }

  private async cleanupRuntimeBinding(nodeId: string, routeId: string): Promise<unknown> {
    const errors: unknown[] = [];
    try {
      await this.runtime.deactivateRoute(nodeId, routeId);
    } catch (error) {
      errors.push(error);
    }
    try {
      await Promise.resolve(this.runtime.removeRuntimeConfig?.(nodeId, 'route', routeId));
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 0) return undefined;
    return errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]));
  }

  async claimFailedCreateCleanup(proxyHostId: string): Promise<boolean> {
    const [claimed] = await this.db
      .update(pageRouteTargets)
      .set({ status: 'failed', lastErrorCode: PAGE_ROUTE_CREATE_CLEANUP_PENDING, updatedAt: new Date() })
      .where(
        and(
          eq(pageRouteTargets.proxyHostId, proxyHostId),
          eq(pageRouteTargets.status, 'staging'),
          isNull(pageRouteTargets.lastErrorCode)
        )
      )
      .returning({ id: pageRouteTargets.id });
    return Boolean(claimed);
  }

  private async markCreateCleanupPending(proxyHostId: string, generation?: number): Promise<void> {
    try {
      await this.db
        .update(pageRouteTargets)
        .set({ status: 'failed', lastErrorCode: PAGE_ROUTE_CREATE_CLEANUP_PENDING, updatedAt: new Date() })
        .where(
          and(
            eq(pageRouteTargets.proxyHostId, proxyHostId),
            ...(generation === undefined
              ? []
              : [eq(pageRouteTargets.generation, generation), eq(pageRouteTargets.status, 'staging')])
          )
        );
    } catch {
      // Keep the original daemon failure. The target row remains owned by the
      // proxy host and the next reconciliation can retry the state transition.
    }
  }

  private async claimRouteRemoval(target: {
    id: string;
    generation: number;
    status: 'pending' | 'staging' | 'ready' | 'failed' | 'capability_missing';
  }): Promise<{ generation: number } | null> {
    const [claimed] = await this.db
      .update(pageRouteTargets)
      .set({
        status: 'staging',
        generation: target.generation + 1,
        lastErrorCode: PAGE_ROUTE_REMOVAL_CLEANUP_CLAIMED,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pageRouteTargets.id, target.id),
          eq(pageRouteTargets.generation, target.generation),
          eq(pageRouteTargets.status, target.status)
        )
      )
      .returning({ generation: pageRouteTargets.generation });
    return claimed ?? null;
  }

  private async markRouteRemovalPending(targetId: string, generation: number): Promise<void> {
    try {
      await this.db
        .update(pageRouteTargets)
        .set({ status: 'failed', lastErrorCode: PAGE_ROUTE_REMOVAL_CLEANUP_PENDING, updatedAt: new Date() })
        .where(
          and(
            eq(pageRouteTargets.id, targetId),
            eq(pageRouteTargets.generation, generation),
            eq(pageRouteTargets.status, 'staging'),
            eq(pageRouteTargets.lastErrorCode, PAGE_ROUTE_REMOVAL_CLEANUP_CLAIMED)
          )
        );
    } catch {
      // The durable staging claim remains non-ready and is safe to inspect or
      // recover without reviving a Route whose daemon cleanup was uncertain.
    }
  }

  private async markRouteRemovalConflict(targetId: string, generation: number): Promise<void> {
    try {
      await this.db
        .update(pageRouteTargets)
        .set({ status: 'failed', lastErrorCode: PAGE_ROUTE_REMOVAL_CLEANUP_CONFLICT, updatedAt: new Date() })
        .where(
          and(
            eq(pageRouteTargets.id, targetId),
            eq(pageRouteTargets.generation, generation),
            eq(pageRouteTargets.status, 'staging'),
            eq(pageRouteTargets.lastErrorCode, PAGE_ROUTE_REMOVAL_CLEANUP_CLAIMED)
          )
        );
    } catch {
      // The still-claimed target remains non-ready and cannot be deleted by a
      // later reconciliation pass without an explicit operator decision.
    }
  }

  private async deleteDisabledCleanupHost(proxyHostId: string): Promise<boolean> {
    const [removed] = await this.db
      .delete(proxyHosts)
      .where(and(eq(proxyHosts.id, proxyHostId), eq(proxyHosts.upstreamKind, 'pages'), eq(proxyHosts.enabled, false)))
      .returning({ id: proxyHosts.id });
    return Boolean(removed);
  }

  private hasDeferredCleanupClaim(target: {
    status: 'pending' | 'staging' | 'ready' | 'failed' | 'capability_missing';
    lastErrorCode: string | null;
  }): boolean {
    return (
      (target.status === 'failed' &&
        [PAGE_ROUTE_CREATE_CLEANUP_PENDING, PAGE_ROUTE_REMOVAL_CLEANUP_PENDING].includes(target.lastErrorCode ?? '')) ||
      (target.status === 'staging' && target.lastErrorCode === PAGE_ROUTE_REMOVAL_CLEANUP_CLAIMED)
    );
  }

  async stageNodeMigration(
    proxyHostId: string,
    sourceNodeId: string,
    targetNodeId: string
  ): Promise<PageRouteNodeMigration> {
    return this.withRouteLock(proxyHostId, async () => {
      const [target] = await this.db
        .select()
        .from(pageRouteTargets)
        .where(eq(pageRouteTargets.proxyHostId, proxyHostId))
        .limit(1);
      if (!target?.activeDeploymentId) {
        throw new AppError(409, 'PAGES_ROUTE_NOT_READY', 'Pages Route has no active Deployment');
      }
      if (target.status !== 'ready') {
        throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route is being changed concurrently');
      }
      const [claimed] = await this.db
        .update(pageRouteTargets)
        .set({
          status: 'staging',
          generation: target.generation + 1,
          lastErrorCode: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(pageRouteTargets.id, target.id),
            eq(pageRouteTargets.generation, target.generation),
            eq(pageRouteTargets.status, target.status)
          )
        )
        .returning({ generation: pageRouteTargets.generation });
      if (!claimed) throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route changed concurrently');
      let includePath: string;
      try {
        const config = await this.runtimeConfig.getEffective(target.projectId, target.tagId);
        const configGeneration = target.runtimeConfigGeneration || 1;
        await this.runtime.publishRuntimeConfig(targetNodeId, 'route', proxyHostId, configGeneration, config.value);
        includePath = await this.runtime.activateRoute(targetNodeId, proxyHostId, target.activeDeploymentId);
        const [updated] = await this.db
          .update(pageRouteTargets)
          .set({
            includePath,
            runtimeConfigGeneration: configGeneration,
            lastErrorCode: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(pageRouteTargets.id, target.id),
              eq(pageRouteTargets.generation, claimed.generation),
              eq(pageRouteTargets.status, 'staging'),
              eq(pageRouteTargets.activeDeploymentId, target.activeDeploymentId)
            )
          )
          .returning({ generation: pageRouteTargets.generation });
        if (!updated) throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route changed concurrently');
        return {
          routeId: proxyHostId,
          sourceNodeId,
          targetNodeId,
          deploymentId: target.activeDeploymentId,
          previousIncludePath: target.includePath,
          targetIncludePath: includePath,
          generation: updated.generation,
        };
      } catch (error) {
        await this.runtime.deactivateRoute(targetNodeId, proxyHostId).catch(() => undefined);
        await this.db
          .update(pageRouteTargets)
          .set({
            status: target.status,
            generation: claimed.generation + 1,
            lastErrorCode: target.lastErrorCode,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(pageRouteTargets.id, target.id),
              eq(pageRouteTargets.generation, claimed.generation),
              eq(pageRouteTargets.status, 'staging')
            )
          );
        throw error;
      }
    });
  }

  async commitNodeMigration(migration: PageRouteNodeMigration): Promise<void> {
    await this.withRouteLock(migration.routeId, async () => {
      const [committed] = await this.db
        .update(pageRouteTargets)
        .set({ status: 'ready', generation: migration.generation + 1, lastErrorCode: null, updatedAt: new Date() })
        .where(
          and(
            eq(pageRouteTargets.proxyHostId, migration.routeId),
            eq(pageRouteTargets.includePath, migration.targetIncludePath),
            eq(pageRouteTargets.activeDeploymentId, migration.deploymentId),
            eq(pageRouteTargets.generation, migration.generation),
            eq(pageRouteTargets.status, 'staging')
          )
        )
        .returning({ id: pageRouteTargets.id });
      if (!committed) {
        throw new AppError(409, 'PAGES_ROUTE_MIGRATION_OWNERSHIP_LOST', 'Pages Route migration claim was lost');
      }
    });
  }

  async rollbackNodeMigration(migration: PageRouteNodeMigration): Promise<void> {
    await this.withRouteLock(migration.routeId, async () => {
      const [current] = await this.db
        .select()
        .from(pageRouteTargets)
        .where(eq(pageRouteTargets.proxyHostId, migration.routeId))
        .limit(1);
      if (
        !current ||
        current.includePath !== migration.targetIncludePath ||
        current.activeDeploymentId !== migration.deploymentId ||
        current.generation !== migration.generation ||
        current.status !== 'staging'
      ) {
        throw new AppError(500, 'PAGES_ROUTE_MIGRATION_OWNERSHIP_LOST', 'Pages Route migration claim was lost');
      }
      const [claimed] = await this.db
        .update(pageRouteTargets)
        .set({ status: 'staging', generation: current.generation + 1, updatedAt: new Date() })
        .where(
          and(
            eq(pageRouteTargets.id, current.id),
            eq(pageRouteTargets.includePath, migration.targetIncludePath),
            eq(pageRouteTargets.activeDeploymentId, migration.deploymentId),
            eq(pageRouteTargets.generation, migration.generation),
            eq(pageRouteTargets.status, current.status)
          )
        )
        .returning({ generation: pageRouteTargets.generation });
      if (!claimed) throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route changed concurrently');
      try {
        await this.runtime.deactivateRoute(migration.targetNodeId, migration.routeId);
        const [restored] = await this.db
          .update(pageRouteTargets)
          .set({
            includePath: migration.previousIncludePath,
            status: 'ready',
            generation: claimed.generation + 1,
            lastErrorCode: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(pageRouteTargets.id, current.id),
              eq(pageRouteTargets.generation, claimed.generation),
              eq(pageRouteTargets.status, 'staging')
            )
          )
          .returning({ id: pageRouteTargets.id });
        if (!restored) throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route changed concurrently');
      } catch {
        await this.db
          .update(pageRouteTargets)
          .set({
            status: 'failed',
            lastErrorCode: 'PAGES_ROUTE_MIGRATION_ROLLBACK_FAILED',
            updatedAt: new Date(),
          })
          .where(and(eq(pageRouteTargets.id, current.id), eq(pageRouteTargets.generation, claimed.generation)));
        throw new AppError(500, 'PAGES_ROUTE_MIGRATION_ROLLBACK_FAILED', 'Pages Route migration rollback failed');
      }
    });
  }

  async cleanupMigratedSource(proxyHostId: string, sourceNodeId: string, connected: boolean): Promise<void> {
    if (connected) await this.runtime.deactivateRoute(sourceNodeId, proxyHostId);
  }

  async retarget(proxyHostId: string, projectId: string, tagId: string, userId: string): Promise<void> {
    const deployment = await this.targetDeployment(projectId, tagId);
    const config = await this.runtimeConfig.getEffective(projectId, tagId);
    const [host] = await this.db
      .select({ nodeId: proxyHosts.nodeId, upstreamKind: proxyHosts.upstreamKind })
      .from(proxyHosts)
      .where(eq(proxyHosts.id, proxyHostId))
      .limit(1);
    if (!host?.nodeId || host.upstreamKind !== 'pages') {
      throw new AppError(409, 'PAGES_ROUTE_NOT_FOUND', 'Route is not a Pages Route');
    }
    await this.withRouteLock(proxyHostId, async () => {
      const [before] = await this.db
        .select()
        .from(pageRouteTargets)
        .where(eq(pageRouteTargets.proxyHostId, proxyHostId))
        .limit(1);
      if (!before) throw new AppError(404, 'PAGES_ROUTE_NOT_FOUND', 'Pages Route target not found');
      if (!['ready', 'failed'].includes(before.status)) {
        throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route is being changed concurrently');
      }
      const [claimed] = await this.db
        .update(pageRouteTargets)
        .set({ status: 'staging', generation: before.generation + 1, lastErrorCode: null, updatedAt: new Date() })
        .where(
          and(
            eq(pageRouteTargets.id, before.id),
            eq(pageRouteTargets.generation, before.generation),
            eq(pageRouteTargets.status, before.status)
          )
        )
        .returning({ generation: pageRouteTargets.generation });
      if (!claimed) throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route changed concurrently');
      let includePath: string;
      const configGeneration = before.runtimeConfigGeneration + 1;
      try {
        await this.runtime.publishRuntimeConfig(host.nodeId!, 'route', proxyHostId, configGeneration, config.value);
        includePath = await this.runtime.activateRoute(host.nodeId!, proxyHostId, deployment.id);
        const [updated] = await this.db
          .update(pageRouteTargets)
          .set({
            projectId,
            tagId,
            activeDeploymentId: deployment.id,
            includePath,
            runtimeConfigGeneration: configGeneration,
            status: 'ready',
            generation: claimed.generation + 1,
            lastErrorCode: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(pageRouteTargets.id, before.id),
              eq(pageRouteTargets.generation, claimed.generation),
              eq(pageRouteTargets.status, 'staging'),
              before.activeDeploymentId
                ? eq(pageRouteTargets.activeDeploymentId, before.activeDeploymentId)
                : isNull(pageRouteTargets.activeDeploymentId)
            )
          )
          .returning();
        if (!updated) throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route changed concurrently');
      } catch (error) {
        if (before.activeDeploymentId) {
          await this.runtime.activateRoute(host.nodeId!, proxyHostId, before.activeDeploymentId).catch(() => undefined);
        } else {
          await this.runtime.deactivateRoute(host.nodeId!, proxyHostId).catch(() => undefined);
        }
        await this.restoreRouteRuntimeConfig(host.nodeId!, proxyHostId, before.runtimeConfigGeneration).catch(
          () => undefined
        );
        await this.db
          .update(pageRouteTargets)
          .set({
            status: before.status,
            generation: claimed.generation + 1,
            lastErrorCode: before.lastErrorCode,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(pageRouteTargets.id, before.id),
              eq(pageRouteTargets.generation, claimed.generation),
              eq(pageRouteTargets.status, 'staging')
            )
          );
        throw error;
      }
    });
    await this.auditService.log({
      userId,
      action: 'page_route.retarget',
      resourceType: 'proxy_host',
      resourceId: proxyHostId,
      details: { projectId, tagId, deploymentId: deployment.id },
    });
  }

  async stage(request: PageTagActivationRequest): Promise<Record<string, unknown>> {
    const routes = await this.db
      .select({ target: pageRouteTargets, nodeId: proxyHosts.nodeId })
      .from(pageRouteTargets)
      .innerJoin(proxyHosts, eq(pageRouteTargets.proxyHostId, proxyHosts.id))
      .where(and(eq(pageRouteTargets.tagId, request.tagId), eq(proxyHosts.upstreamKind, 'pages')));
    const applied: RouteProgress[] = [];
    try {
      for (const route of routes.sort((left, right) =>
        left.target.proxyHostId.localeCompare(right.target.proxyHostId)
      )) {
        if (!route.nodeId) throw new AppError(409, 'PAGES_ROUTE_NODE_MISSING', 'Pages Route has no Nginx node');
        await this.withRouteLock(route.target.proxyHostId, async () => {
          const [current] = await this.db
            .select()
            .from(pageRouteTargets)
            .where(eq(pageRouteTargets.proxyHostId, route.target.proxyHostId))
            .limit(1);
          if (!current || current.tagId !== request.tagId || !['ready', 'failed'].includes(current.status)) {
            throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route changed concurrently');
          }
          const [claimed] = await this.db
            .update(pageRouteTargets)
            .set({
              status: 'staging',
              generation: current.generation + 1,
              lastErrorCode: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(pageRouteTargets.id, current.id),
                eq(pageRouteTargets.generation, current.generation),
                eq(pageRouteTargets.tagId, request.tagId),
                eq(pageRouteTargets.status, current.status)
              )
            )
            .returning({ generation: pageRouteTargets.generation });
          if (!claimed) {
            throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route changed concurrently');
          }

          const configGeneration = current.runtimeConfigGeneration + 1;
          const progress: RouteProgress = {
            routeId: current.proxyHostId,
            nodeId: route.nodeId!,
            fromDeploymentId: current.activeDeploymentId,
            toDeploymentId: request.deploymentId,
            fromStatus: current.status as RouteProgress['fromStatus'],
            fromRuntimeConfigGeneration: current.runtimeConfigGeneration,
            toRuntimeConfigGeneration: configGeneration,
            // Record the claim before touching the daemon. If the final CAS
            // is rejected, the outer rollback still owns this staging row.
            claimedGeneration: claimed.generation,
            generation: claimed.generation,
          };
          applied.push(progress);

          const config = await this.runtimeConfig.getEffective(current.projectId, current.tagId);
          await this.runtime.publishRuntimeConfig(
            route.nodeId!,
            'route',
            current.proxyHostId,
            configGeneration,
            config.value
          );
          await this.runtime.activateRoute(route.nodeId!, current.proxyHostId, request.deploymentId);

          const [updated] = await this.db
            .update(pageRouteTargets)
            .set({
              activeDeploymentId: request.deploymentId,
              runtimeConfigGeneration: configGeneration,
              status: 'ready',
              generation: claimed.generation + 1,
              lastErrorCode: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(pageRouteTargets.id, current.id),
                eq(pageRouteTargets.generation, claimed.generation),
                eq(pageRouteTargets.tagId, request.tagId),
                eq(pageRouteTargets.status, 'staging'),
                current.activeDeploymentId
                  ? eq(pageRouteTargets.activeDeploymentId, current.activeDeploymentId)
                  : isNull(pageRouteTargets.activeDeploymentId)
              )
            )
            .returning({ generation: pageRouteTargets.generation });
          if (!updated) throw new AppError(409, 'PAGES_ROUTE_CHANGED', 'Pages Route changed concurrently');
          progress.generation = updated.generation;
        });
      }
      const additional = await this.additionalRoutes?.stageTagPublication(request);
      return { routes: applied, ...(additional ? { additional } : {}) };
    } catch (error) {
      await this.rollbackRoutes(applied);
      throw error;
    }
  }

  async rollback(_request: PageTagActivationRequest, progress: Record<string, unknown>): Promise<void> {
    const additional = progress.additional;
    if (additional && this.additionalRoutes?.rollbackTagPublication) {
      await this.additionalRoutes.rollbackTagPublication(_request, additional as Record<string, unknown>);
    }
    const routes = Array.isArray(progress.routes) ? (progress.routes as RouteProgress[]) : [];
    await this.rollbackRoutes(routes);
  }

  private async rollbackRoutes(routes: RouteProgress[]): Promise<void> {
    for (const route of [...routes].reverse()) {
      await this.withRouteLock(route.routeId, async () => {
        const [current] = await this.db
          .select()
          .from(pageRouteTargets)
          .where(eq(pageRouteTargets.proxyHostId, route.routeId))
          .limit(1);
        if (!current) return;
        const claimGeneration = route.claimedGeneration ?? route.generation;
        const ownsStagingClaim = current.status === 'staging' && current.generation === claimGeneration;
        const ownsCompletedClaim =
          current.status === 'ready' &&
          current.activeDeploymentId === route.toDeploymentId &&
          current.generation === route.generation;
        if (!ownsStagingClaim && !ownsCompletedClaim) return;
        const fromRuntimeConfigGeneration = route.fromRuntimeConfigGeneration ?? current.runtimeConfigGeneration;
        try {
          if (route.fromDeploymentId) {
            await this.runtime.activateRoute(route.nodeId, route.routeId, route.fromDeploymentId);
          } else {
            await this.runtime.deactivateRoute(route.nodeId, route.routeId);
          }
          await this.restoreRouteRuntimeConfig(route.nodeId, route.routeId, fromRuntimeConfigGeneration);
          const [restored] = await this.db
            .update(pageRouteTargets)
            .set({
              activeDeploymentId: route.fromDeploymentId,
              runtimeConfigGeneration: fromRuntimeConfigGeneration,
              generation: current.generation + 1,
              status: route.fromStatus ?? (route.fromDeploymentId ? 'ready' : 'pending'),
              lastErrorCode: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(pageRouteTargets.id, current.id),
                eq(pageRouteTargets.generation, current.generation),
                current.activeDeploymentId
                  ? eq(pageRouteTargets.activeDeploymentId, current.activeDeploymentId)
                  : isNull(pageRouteTargets.activeDeploymentId),
                eq(pageRouteTargets.status, current.status)
              )
            )
            .returning({ id: pageRouteTargets.id });
          if (!restored) {
            throw new AppError(500, 'PAGES_ROUTE_ROLLBACK_FAILED', 'Pages Route rollback changed concurrently');
          }
        } catch {
          await this.db
            .update(pageRouteTargets)
            .set({ status: 'failed', lastErrorCode: 'PAGES_ROUTE_ROLLBACK_FAILED', updatedAt: new Date() })
            .where(
              and(
                eq(pageRouteTargets.id, current.id),
                eq(pageRouteTargets.generation, current.generation),
                eq(pageRouteTargets.status, current.status)
              )
            );
          throw new AppError(500, 'PAGES_ROUTE_ROLLBACK_FAILED', 'Pages Route rollback failed');
        }
      });
    }
  }

  private async targetDeployment(projectId: string, tagId: string) {
    return (await this.targetSnapshot(projectId, tagId)).deployment;
  }

  private async assertPagesRouteNode(nodeId: string): Promise<void> {
    const [node] = await this.db
      .select({ type: nodes.type, status: nodes.status, capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');
    if (node.type !== 'nginx' || node.status !== 'online' || !hasRequiredNginxPagesCapabilities(node.capabilities)) {
      throw new AppError(409, 'PAGES_DAEMON_UPDATE_REQUIRED', 'Update the selected Nginx daemon to use Pages');
    }
  }

  private async assertTagActivationIdle(tagId: string): Promise<void> {
    const [activation] = await this.db
      .select({ id: pageTagActivations.id })
      .from(pageTagActivations)
      .where(
        and(
          eq(pageTagActivations.tagId, tagId),
          inArray(pageTagActivations.status, ['requested', 'staging_consumers', 'switching', 'rolling_back'])
        )
      )
      .limit(1);
    if (activation) {
      throw new AppError(409, 'PAGES_TAG_PUBLICATION_ACTIVE', 'Pages Tag is being published; retry Route creation');
    }
  }

  private async targetSnapshot(projectId: string, tagId: string) {
    const [target] = await this.db
      .select({ deployment: pageDeployments, generation: pageTags.generation })
      .from(pageTags)
      .innerJoin(pageDeployments, eq(pageTags.deploymentId, pageDeployments.id))
      .where(and(eq(pageTags.id, tagId), eq(pageTags.projectId, projectId), eq(pageDeployments.status, 'ready')))
      .limit(1);
    if (!target) throw new AppError(409, 'PAGES_TAG_NOT_DEPLOYED', 'Select a Tag with a ready Deployment');
    return target;
  }

  private async withRouteLock<T>(routeId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.routeLocks.get(routeId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.routeLocks.set(routeId, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.routeLocks.get(routeId) === queued) this.routeLocks.delete(routeId);
    }
  }
}
