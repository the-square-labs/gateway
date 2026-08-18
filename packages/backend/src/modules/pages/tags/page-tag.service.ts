import { and, desc, eq, inArray, max, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { pageDeployments, pageTagActivations, pageTags } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { PAGE_EVENT_CHANNELS, pageProjectEvent } from '../page-events.js';

const ACTIVE_ACTIVATION_STATUSES = ['requested', 'staging_consumers', 'switching'] as const;

export interface PageTagActivationRequest {
  id: string;
  projectId: string;
  tagId: string;
  tag: string;
  deploymentId: string;
  publicSlug: string;
  sequence: number;
  expectedGeneration: number;
  requestedById: string | null;
}

export class PageTagService {
  private eventBus?: EventBusService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  async list(projectId: string) {
    const rows = await this.db
      .select({ tag: pageTags, deployment: pageDeployments })
      .from(pageTags)
      .leftJoin(pageDeployments, eq(pageTags.deploymentId, pageDeployments.id))
      .where(eq(pageTags.projectId, projectId))
      .orderBy(desc(pageTags.system), pageTags.name);
    return rows.map(({ tag, deployment }) => ({
      id: tag.id,
      projectId: tag.projectId,
      name: tag.name,
      system: tag.system,
      generation: tag.generation,
      deployment: deployment
        ? {
            id: deployment.id,
            sequence: deployment.sequence,
            publicSlug: deployment.publicSlug,
            status: deployment.status,
          }
        : null,
      createdAt: tag.createdAt.toISOString(),
      updatedAt: tag.updatedAt.toISOString(),
    }));
  }

  async beginActivation(
    projectId: string,
    tagName: string,
    deploymentId: string,
    userId: string | null,
    options: { systemLatest?: boolean } = {}
  ): Promise<PageTagActivationRequest | null> {
    if ((tagName === 'latest') !== Boolean(options.systemLatest)) {
      throw new AppError(403, 'PAGE_TAG_SYSTEM_MANAGED', '`latest` is managed by the deployment pipeline');
    }

    return this.db.transaction(async (tx) => {
      const [deployment] = await tx
        .select()
        .from(pageDeployments)
        .where(and(eq(pageDeployments.id, deploymentId), eq(pageDeployments.projectId, projectId)))
        .limit(1);
      if (!deployment) throw new AppError(404, 'PAGE_DEPLOYMENT_NOT_FOUND', 'Page Deployment not found');
      if (deployment.status !== 'ready') {
        throw new AppError(409, 'PAGE_DEPLOYMENT_NOT_READY', 'Only a ready Deployment can receive a Tag');
      }

      let [tag] = await tx
        .select()
        .from(pageTags)
        .where(and(eq(pageTags.projectId, projectId), eq(pageTags.name, tagName)))
        .limit(1);
      if (!tag) {
        if (tagName === 'latest') throw new AppError(500, 'PAGE_LATEST_TAG_MISSING', 'Project latest Tag is missing');
        [tag] = await tx
          .insert(pageTags)
          .values({ projectId, name: tagName, system: false, updatedById: userId })
          .returning();
      }
      if (!tag) throw new AppError(500, 'PAGE_TAG_CREATE_FAILED', 'Page Tag was not created');
      if (tag.deploymentId === deployment.id) return null;

      if (tagName === 'latest') {
        const [current] = tag.deploymentId
          ? await tx
              .select({ sequence: pageDeployments.sequence })
              .from(pageDeployments)
              .where(eq(pageDeployments.id, tag.deploymentId))
              .limit(1)
          : [];
        const [{ sequence: pendingSequence }] = await tx
          .select({ sequence: max(pageDeployments.sequence) })
          .from(pageTagActivations)
          .innerJoin(pageDeployments, eq(pageTagActivations.toDeploymentId, pageDeployments.id))
          .where(
            and(
              eq(pageTagActivations.tagId, tag.id),
              inArray(pageTagActivations.status, [...ACTIVE_ACTIVATION_STATUSES])
            )
          );
        const newestSequence = Math.max(current?.sequence ?? 0, pendingSequence ?? 0);
        if (deployment.sequence <= newestSequence) return null;
      }

      const [updatedTag] = await tx
        .update(pageTags)
        .set({
          generation: sql`${pageTags.generation} + 1`,
          updatedById: userId,
          updatedAt: new Date(),
        })
        .where(eq(pageTags.id, tag.id))
        .returning();
      if (!updatedTag) throw new AppError(409, 'PAGE_TAG_CHANGED', 'Page Tag changed concurrently');

      const [activation] = await tx
        .insert(pageTagActivations)
        .values({
          tagId: tag.id,
          fromDeploymentId: tag.deploymentId,
          toDeploymentId: deployment.id,
          expectedGeneration: updatedTag.generation,
          requestedById: userId,
        })
        .returning();
      if (!activation) throw new AppError(500, 'PAGE_TAG_ACTIVATION_CREATE_FAILED', 'Tag activation was not created');

      return {
        id: activation.id,
        projectId,
        tagId: tag.id,
        tag: tag.name,
        deploymentId: deployment.id,
        publicSlug: deployment.publicSlug,
        sequence: deployment.sequence,
        expectedGeneration: updatedTag.generation,
        requestedById: userId,
      };
    });
  }

  async markStaging(activationId: string, progress: Record<string, unknown> = {}): Promise<void> {
    await this.db
      .update(pageTagActivations)
      .set({ status: 'staging_consumers', progress, updatedAt: new Date() })
      .where(
        and(
          eq(pageTagActivations.id, activationId),
          inArray(pageTagActivations.status, ['requested', 'staging_consumers'])
        )
      );
  }

  async markRollingBack(activationId: string, progress: Record<string, unknown>): Promise<void> {
    await this.db
      .update(pageTagActivations)
      .set({ status: 'rolling_back', progress, updatedAt: new Date() })
      .where(
        and(
          eq(pageTagActivations.id, activationId),
          inArray(pageTagActivations.status, ['requested', 'staging_consumers', 'switching'])
        )
      );
  }

  async completeActivation(request: PageTagActivationRequest): Promise<boolean> {
    const completed = await this.db.transaction(async (tx) => {
      const [target] = await tx
        .update(pageDeployments)
        .set({ updatedAt: sql`${pageDeployments.updatedAt}` })
        .where(and(eq(pageDeployments.id, request.deploymentId), eq(pageDeployments.status, 'ready')))
        .returning({ id: pageDeployments.id });
      if (!target) {
        await tx
          .update(pageTagActivations)
          .set({
            status: 'failed',
            failureCode: 'PAGE_TAG_TARGET_UNAVAILABLE',
            failureMessage: 'The target Deployment is no longer ready',
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(pageTagActivations.id, request.id));
        return false;
      }
      await tx
        .update(pageTagActivations)
        .set({ status: 'switching', updatedAt: new Date() })
        .where(
          and(
            eq(pageTagActivations.id, request.id),
            inArray(pageTagActivations.status, ['requested', 'staging_consumers'])
          )
        );
      const [tag] = await tx
        .update(pageTags)
        .set({ deploymentId: request.deploymentId, updatedAt: new Date() })
        .where(and(eq(pageTags.id, request.tagId), eq(pageTags.generation, request.expectedGeneration)))
        .returning();
      if (!tag) {
        await tx
          .update(pageTagActivations)
          .set({
            status: 'failed',
            failureCode: 'PAGE_TAG_ACTIVATION_SUPERSEDED',
            failureMessage: 'A newer Tag activation superseded this request',
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(pageTagActivations.id, request.id));
        return false;
      }
      const [completedActivation] = await tx
        .update(pageTagActivations)
        .set({
          status: 'ready',
          failureCode: null,
          failureMessage: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(pageTagActivations.id, request.id), eq(pageTagActivations.status, 'switching')))
        .returning({ id: pageTagActivations.id });
      if (!completedActivation) {
        throw new AppError(409, 'PAGE_TAG_ACTIVATION_CHANGED', 'Tag activation changed concurrently');
      }
      return true;
    });

    if (!completed) return false;
    await this.auditService.log({
      userId: request.requestedById,
      action: 'page_tag.move',
      resourceType: 'page_tag',
      resourceId: request.tagId,
      details: {
        projectId: request.projectId,
        tag: request.tag,
        deploymentId: request.deploymentId,
        publicSlug: request.publicSlug,
        sequence: request.sequence,
        generation: request.expectedGeneration,
      },
    });
    this.eventBus?.publish(
      PAGE_EVENT_CHANNELS.tag,
      pageProjectEvent(request.projectId, 'moved', {
        id: request.tagId,
        tag: request.tag,
        deploymentId: request.deploymentId,
        publicSlug: request.publicSlug,
        sequence: request.sequence,
        generation: request.expectedGeneration,
        status: 'ready',
      })
    );
    return true;
  }

  async failActivation(request: PageTagActivationRequest, failureCode: string): Promise<void> {
    const safeCode = failureCode.slice(0, 128);
    await this.db
      .update(pageTagActivations)
      .set({
        status: 'failed',
        failureCode: safeCode,
        failureMessage: 'Tag publication failed',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(pageTagActivations.id, request.id));
    this.eventBus?.publish(
      PAGE_EVENT_CHANNELS.tag,
      pageProjectEvent(request.projectId, 'publication.failed', {
        id: request.tagId,
        tag: request.tag,
        deploymentId: request.deploymentId,
        publicSlug: request.publicSlug,
        generation: request.expectedGeneration,
        status: 'failed',
        failureCode: safeCode,
      })
    );
  }

  async delete(projectId: string, tagName: string, userId: string): Promise<void> {
    let deletedTag: typeof pageTags.$inferSelect;
    try {
      deletedTag = await this.db.transaction(async (tx) => {
        const [tag] = await tx
          .update(pageTags)
          .set({ updatedAt: sql`${pageTags.updatedAt}` })
          .where(and(eq(pageTags.projectId, projectId), eq(pageTags.name, tagName)))
          .returning();
        if (!tag) throw new AppError(404, 'PAGE_TAG_NOT_FOUND', 'Page Tag not found');
        if (tag.system) throw new AppError(409, 'PAGE_TAG_SYSTEM_MANAGED', 'System Tags cannot be deleted');
        const [activation] = await tx
          .select({ id: pageTagActivations.id })
          .from(pageTagActivations)
          .where(
            and(
              eq(pageTagActivations.tagId, tag.id),
              inArray(pageTagActivations.status, [...ACTIVE_ACTIVATION_STATUSES])
            )
          )
          .limit(1);
        if (activation) {
          throw new AppError(409, 'PAGE_TAG_PUBLICATION_ACTIVE', 'Page Tag has an active publication');
        }
        await tx.delete(pageTags).where(eq(pageTags.id, tag.id));
        return tag;
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23503') {
        throw new AppError(409, 'PAGE_TAG_IN_USE', 'Page Tag is referenced by a Route or active publication');
      }
      throw error;
    }
    await this.auditService.log({
      userId,
      action: 'page_tag.delete',
      resourceType: 'page_tag',
      resourceId: deletedTag.id,
      details: { projectId, tag: deletedTag.name, deploymentId: deletedTag.deploymentId },
    });
    this.eventBus?.publish(
      PAGE_EVENT_CHANNELS.tag,
      pageProjectEvent(projectId, 'deleted', { id: deletedTag.id, tag: deletedTag.name })
    );
  }
}
