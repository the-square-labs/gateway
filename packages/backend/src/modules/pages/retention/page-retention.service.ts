import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  pageDeploymentReplicas,
  pageDeployments,
  pageIngressMigrations,
  pageProjects,
  pageRouteTargets,
  pageTagActivations,
  pageTags,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { PageArtifactStore } from '../artifacts/page-artifact-store.js';
import { PAGE_EVENT_CHANNELS, pageProjectEvent } from '../page-events.js';

const ACTIVE_ACTIVATIONS = ['requested', 'staging_consumers', 'switching'] as const;
const ACTIVE_MIGRATIONS = [
  'preflight',
  'staging',
  'applying',
  'switching_dns',
  'verifying',
  'cleanup_pending',
  'needs_attention',
] as const;

export type PageDeploymentProtectionReason = 'pinned' | 'tag' | 'route' | 'publication' | 'replica' | 'migration';

export interface PageRetentionRunResult {
  itemsCleaned: number;
  spaceFreedBytes: number;
  protectedOverLimit: number;
}

export interface PageRetentionRuntimeAdapter {
  cleanupRetainedDeployment(deploymentId: string): Promise<void>;
}

const NOOP_RUNTIME_ADAPTER: PageRetentionRuntimeAdapter = {
  cleanupRetainedDeployment: async () => undefined,
};

export class PageRetentionService {
  private eventBus?: EventBusService;
  private runtimeAdapter: PageRetentionRuntimeAdapter = NOOP_RUNTIME_ADAPTER;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly store: PageArtifactStore
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  setRuntimeAdapter(adapter: PageRetentionRuntimeAdapter): void {
    this.runtimeAdapter = adapter;
  }

  async assertCanAcceptDeployment(projectId: string): Promise<void> {
    const [project] = await this.db.select().from(pageProjects).where(eq(pageProjects.id, projectId)).limit(1);
    if (!project) throw new AppError(404, 'PAGE_PROJECT_NOT_FOUND', 'Page Project not found');
    const deployments = await this.db
      .select()
      .from(pageDeployments)
      .where(and(eq(pageDeployments.projectId, projectId), eq(pageDeployments.status, 'ready')));
    const protectedReasons = await this.getProtectionReasons(projectId, deployments);
    const protectedCount = deployments.filter((deployment) => protectedReasons.has(deployment.id)).length;
    if (protectedCount < project.maxDeployments) return;

    this.emitQuota(project, 'quota.blocked', 'PAGES_RETENTION_PROTECTED_LIMIT');
    throw new AppError(
      409,
      'PAGES_RETENTION_PROTECTED_LIMIT',
      'Protected Deployments already fill this Project retention limit',
      { protectedCount, maxDeployments: project.maxDeployments }
    );
  }

  async setPinned(projectId: string, deploymentId: string, pinned: boolean, userId: string) {
    const [deployment] = await this.db
      .update(pageDeployments)
      .set({ pinned, updatedAt: new Date() })
      .where(and(eq(pageDeployments.id, deploymentId), eq(pageDeployments.projectId, projectId)))
      .returning();
    if (!deployment) throw new AppError(404, 'PAGE_DEPLOYMENT_NOT_FOUND', 'Page Deployment not found');
    await this.auditService.log({
      userId,
      action: pinned ? 'page_deployment.pin' : 'page_deployment.unpin',
      resourceType: 'page_deployment',
      resourceId: deployment.id,
      details: { projectId, publicSlug: deployment.publicSlug },
    });
    this.eventBus?.publish(
      PAGE_EVENT_CHANNELS.deployment,
      pageProjectEvent(projectId, pinned ? 'pinned' : 'unpinned', {
        id: deployment.id,
        deploymentId: deployment.id,
        publicSlug: deployment.publicSlug,
        status: deployment.status,
      })
    );
    return { id: deployment.id, pinned };
  }

  async deleteDeployment(projectId: string, deploymentId: string, userId: string): Promise<void> {
    const [deployment] = await this.db
      .select()
      .from(pageDeployments)
      .where(and(eq(pageDeployments.id, deploymentId), eq(pageDeployments.projectId, projectId)))
      .limit(1);
    if (!deployment) throw new AppError(404, 'PAGE_DEPLOYMENT_NOT_FOUND', 'Page Deployment not found');
    let reasons = (await this.getProtectionReasons(projectId, [deployment])).get(deployment.id) ?? [];
    if (reasons.length === 1 && reasons[0] === 'tag') {
      await this.detachUnconsumedSystemTags(projectId, deployment.id);
      reasons = (await this.getProtectionReasons(projectId, [deployment])).get(deployment.id) ?? [];
    }
    if (reasons.length > 0) {
      throw new AppError(409, 'PAGE_DEPLOYMENT_PROTECTED', 'Deployment is still referenced', { reasons });
    }
    const result = await this.cleanupDeployment(deployment);
    if (!result.cleaned) {
      throw new AppError(409, 'PAGE_DEPLOYMENT_PROTECTED', 'Deployment became referenced during cleanup', {
        reasons: result.reasons,
      });
    }
    await this.auditService.log({
      userId,
      action: 'page_deployment.delete',
      resourceType: 'page_deployment',
      resourceId: deployment.id,
      details: { projectId, publicSlug: deployment.publicSlug, bytesFreed: result.bytesFreed },
    });
    await this.runProject(projectId);
  }

  private async detachUnconsumedSystemTags(projectId: string, deploymentId: string): Promise<void> {
    const tags = await this.db
      .select({ id: pageTags.id, system: pageTags.system })
      .from(pageTags)
      .where(and(eq(pageTags.projectId, projectId), eq(pageTags.deploymentId, deploymentId)));
    if (tags.length === 0 || tags.some((tag) => !tag.system)) return;
    const tagIds = tags.map((tag) => tag.id);
    const [route] = await this.db
      .select({ id: pageRouteTargets.id })
      .from(pageRouteTargets)
      .where(inArray(pageRouteTargets.tagId, tagIds))
      .limit(1);
    if (route) return;
    await this.db
      .update(pageTags)
      .set({ deploymentId: null, generation: sql`${pageTags.generation} + 1`, updatedAt: new Date() })
      .where(
        and(eq(pageTags.projectId, projectId), eq(pageTags.deploymentId, deploymentId), eq(pageTags.system, true))
      );
  }

  async runAll(): Promise<PageRetentionRunResult> {
    const projects = await this.db.select().from(pageProjects);
    const total: PageRetentionRunResult = { itemsCleaned: 0, spaceFreedBytes: 0, protectedOverLimit: 0 };
    for (const project of projects) {
      const result = await this.runProject(project.id);
      total.itemsCleaned += result.itemsCleaned;
      total.spaceFreedBytes += result.spaceFreedBytes;
      total.protectedOverLimit += result.protectedOverLimit;
    }
    return total;
  }

  async runProject(projectId: string): Promise<PageRetentionRunResult> {
    const [project] = await this.db.select().from(pageProjects).where(eq(pageProjects.id, projectId)).limit(1);
    if (!project) return { itemsCleaned: 0, spaceFreedBytes: 0, protectedOverLimit: 0 };
    const successful = await this.db
      .select()
      .from(pageDeployments)
      .where(and(eq(pageDeployments.projectId, projectId), eq(pageDeployments.status, 'ready')))
      .orderBy(desc(pageDeployments.sequence));
    const cleaning = await this.db
      .select()
      .from(pageDeployments)
      .where(and(eq(pageDeployments.projectId, projectId), eq(pageDeployments.status, 'cleaning')));
    const protection = await this.getProtectionReasons(projectId, successful);
    const candidateIds = new Set(successful.slice(project.maxDeployments).map((deployment) => deployment.id));
    let projectedStorageBytes = project.storageUsedBytes;
    for (const deployment of [...successful].reverse()) {
      if (projectedStorageBytes <= project.storageQuotaBytes) break;
      if (protection.has(deployment.id)) continue;
      candidateIds.add(deployment.id);
      projectedStorageBytes -= deployment.compressedSizeBytes;
    }
    const candidates = [...successful.filter((deployment) => candidateIds.has(deployment.id)), ...cleaning];
    let itemsCleaned = 0;
    let spaceFreedBytes = 0;
    let protectedOverLimit = 0;
    for (const deployment of candidates) {
      if (protection.has(deployment.id)) {
        protectedOverLimit += 1;
        continue;
      }
      const result = await this.cleanupDeployment(deployment);
      if (result.cleaned) {
        itemsCleaned += 1;
        spaceFreedBytes += result.bytesFreed;
      } else {
        protectedOverLimit += 1;
      }
    }
    const stillOverStorageQuota = project.storageUsedBytes - spaceFreedBytes > project.storageQuotaBytes;
    const blocked = protectedOverLimit > 0 || stillOverStorageQuota;
    this.emitQuota(project, blocked ? 'quota.blocked' : 'quota.resolved', blocked ? 'PAGES_QUOTA_BLOCKED' : null);
    return { itemsCleaned, spaceFreedBytes, protectedOverLimit };
  }

  private async cleanupDeployment(deployment: typeof pageDeployments.$inferSelect): Promise<{
    cleaned: boolean;
    bytesFreed: number;
    reasons: PageDeploymentProtectionReason[];
  }> {
    const [claimed] = await this.db
      .update(pageDeployments)
      .set({ status: 'cleaning', updatedAt: new Date() })
      .where(
        and(
          eq(pageDeployments.id, deployment.id),
          inArray(pageDeployments.status, ['ready', 'failed', 'cleaning']),
          eq(pageDeployments.updatedAt, deployment.updatedAt)
        )
      )
      .returning();
    if (!claimed) return { cleaned: false, bytesFreed: 0, reasons: ['publication'] };

    const reasons = (await this.getProtectionReasons(deployment.projectId, [claimed])).get(deployment.id) ?? [];
    if (reasons.length > 0) {
      await this.db
        .update(pageDeployments)
        .set({ status: deployment.status, updatedAt: new Date() })
        .where(and(eq(pageDeployments.id, deployment.id), eq(pageDeployments.status, 'cleaning')));
      return { cleaned: false, bytesFreed: 0, reasons };
    }

    await this.runtimeAdapter.cleanupRetainedDeployment(claimed.id);
    if (claimed.artifactKey) await this.store.remove(claimed.artifactKey);
    const deleted = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(pageDeployments)
        .set({ status: 'deleted', artifactKey: null, deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(pageDeployments.id, claimed.id), eq(pageDeployments.status, 'cleaning')))
        .returning({ id: pageDeployments.id });
      if (!updated) return false;
      await tx
        .update(pageProjects)
        .set({
          storageUsedBytes: sql`greatest(0, ${pageProjects.storageUsedBytes} - ${claimed.compressedSizeBytes})`,
          updatedAt: new Date(),
        })
        .where(eq(pageProjects.id, claimed.projectId));
      return true;
    });
    if (!deleted) return { cleaned: false, bytesFreed: 0, reasons: ['publication'] };
    this.eventBus?.publish(
      PAGE_EVENT_CHANNELS.deployment,
      pageProjectEvent(claimed.projectId, 'deleted', {
        id: claimed.id,
        deploymentId: claimed.id,
        publicSlug: claimed.publicSlug,
        status: 'deleted',
      })
    );
    return { cleaned: true, bytesFreed: claimed.compressedSizeBytes, reasons: [] };
  }

  private async getProtectionReasons(
    projectId: string,
    deployments: Array<typeof pageDeployments.$inferSelect>
  ): Promise<Map<string, PageDeploymentProtectionReason[]>> {
    const ids = deployments.map((deployment) => deployment.id);
    const reasons = new Map<string, Set<PageDeploymentProtectionReason>>();
    const add = (id: string | null, reason: PageDeploymentProtectionReason) => {
      if (!id || !ids.includes(id)) return;
      const current = reasons.get(id) ?? new Set<PageDeploymentProtectionReason>();
      current.add(reason);
      reasons.set(id, current);
    };
    for (const deployment of deployments) if (deployment.pinned) add(deployment.id, 'pinned');
    if (ids.length === 0) return new Map();

    const [tags, routes, activations, replicas, migrations] = await Promise.all([
      this.db
        .select({ deploymentId: pageTags.deploymentId })
        .from(pageTags)
        .where(and(eq(pageTags.projectId, projectId), inArray(pageTags.deploymentId, ids))),
      this.db
        .select({ deploymentId: pageRouteTargets.activeDeploymentId })
        .from(pageRouteTargets)
        .where(and(eq(pageRouteTargets.projectId, projectId), inArray(pageRouteTargets.activeDeploymentId, ids))),
      this.db
        .select({
          fromDeploymentId: pageTagActivations.fromDeploymentId,
          toDeploymentId: pageTagActivations.toDeploymentId,
        })
        .from(pageTagActivations)
        .innerJoin(pageTags, eq(pageTagActivations.tagId, pageTags.id))
        .where(and(eq(pageTags.projectId, projectId), inArray(pageTagActivations.status, [...ACTIVE_ACTIVATIONS]))),
      this.db
        .select({ deploymentId: pageDeploymentReplicas.deploymentId })
        .from(pageDeploymentReplicas)
        .where(
          and(
            inArray(pageDeploymentReplicas.deploymentId, ids),
            inArray(pageDeploymentReplicas.status, ['pending', 'uploading', 'materializing'])
          )
        ),
      this.db
        .select({ retainedDeploymentIds: pageIngressMigrations.retainedDeploymentIds })
        .from(pageIngressMigrations)
        .where(
          and(
            eq(pageIngressMigrations.projectId, projectId),
            inArray(pageIngressMigrations.status, [...ACTIVE_MIGRATIONS])
          )
        ),
    ]);
    for (const row of tags) add(row.deploymentId, 'tag');
    for (const row of routes) add(row.deploymentId, 'route');
    for (const row of activations) {
      add(row.fromDeploymentId, 'publication');
      add(row.toDeploymentId, 'publication');
    }
    for (const row of replicas) add(row.deploymentId, 'replica');
    for (const row of migrations) for (const id of row.retainedDeploymentIds) add(id, 'migration');
    return new Map([...reasons].map(([id, values]) => [id, [...values]]));
  }

  private emitQuota(
    project: typeof pageProjects.$inferSelect,
    action: 'quota.blocked' | 'quota.resolved',
    failureCode: string | null
  ): void {
    this.eventBus?.publish(
      PAGE_EVENT_CHANNELS.project,
      pageProjectEvent(project.id, action, {
        id: project.id,
        quotaUsedBytes: project.storageUsedBytes,
        quotaLimitBytes: project.storageQuotaBytes,
        failureCode,
      })
    );
  }
}
