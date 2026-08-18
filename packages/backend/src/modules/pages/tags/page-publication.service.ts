import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { pageDeployments } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { PAGE_EVENT_CHANNELS, pageProjectEvent } from '../page-events.js';
import type { PageTagActivationRequest, PageTagService } from './page-tag.service.js';

export interface PageTagPublicationAdapter {
  stage(request: PageTagActivationRequest): Promise<Record<string, unknown>>;
  rollback?(request: PageTagActivationRequest, progress: Record<string, unknown>): Promise<void>;
}

export interface PageDeploymentPublicationAdapter {
  publish(deploymentId: string): Promise<void>;
}

const NOOP_PUBLICATION_ADAPTER: PageTagPublicationAdapter = {
  stage: async () => ({}),
};

const NOOP_DEPLOYMENT_ADAPTER: PageDeploymentPublicationAdapter = {
  publish: async () => undefined,
};

function publicFailureCode(error: unknown): string {
  if (error instanceof AppError) return error.code.slice(0, 128);
  return 'PAGE_TAG_PUBLICATION_FAILED';
}

export class PagePublicationService {
  private eventBus?: EventBusService;
  private adapter: PageTagPublicationAdapter = NOOP_PUBLICATION_ADAPTER;
  private deploymentAdapter: PageDeploymentPublicationAdapter = NOOP_DEPLOYMENT_ADAPTER;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly tagService: PageTagService
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  setAdapter(adapter: PageTagPublicationAdapter): void {
    this.adapter = adapter;
  }

  setDeploymentAdapter(adapter: PageDeploymentPublicationAdapter): void {
    this.deploymentAdapter = adapter;
  }

  async moveUserTag(projectId: string, tag: string, deploymentId: string, userId: string) {
    const request = await this.tagService.beginActivation(projectId, tag, deploymentId, userId);
    if (!request) return { changed: false };
    const changed = await this.publishTag(request);
    return { changed, activationId: request.id, generation: request.expectedGeneration };
  }

  async markDeploymentReady(deploymentId: string): Promise<void> {
    let [deployment] = await this.db
      .update(pageDeployments)
      .set({ status: 'staging', failureCode: null, failureMessage: null, updatedAt: new Date() })
      .where(and(eq(pageDeployments.id, deploymentId), eq(pageDeployments.status, 'stored')))
      .returning();
    if (!deployment) {
      const [existing] = await this.db
        .select()
        .from(pageDeployments)
        .where(eq(pageDeployments.id, deploymentId))
        .limit(1);
      if (existing?.status !== 'staging' && existing?.status !== 'ready') {
        throw new AppError(409, 'PAGE_DEPLOYMENT_NOT_PUBLISHABLE', 'Deployment is not awaiting publication');
      }
      deployment = existing;
    }

    await this.deploymentAdapter.publish(deployment.id);

    const wasReady = deployment.status === 'ready';
    if (!wasReady) {
      const [ready] = await this.db
        .update(pageDeployments)
        .set({ status: 'ready', readyAt: new Date(), failureCode: null, failureMessage: null, updatedAt: new Date() })
        .where(and(eq(pageDeployments.id, deploymentId), eq(pageDeployments.status, 'staging')))
        .returning();
      if (!ready) {
        const [current] = await this.db
          .select()
          .from(pageDeployments)
          .where(eq(pageDeployments.id, deploymentId))
          .limit(1);
        if (current?.status !== 'ready') {
          throw new AppError(409, 'PAGE_DEPLOYMENT_CHANGED', 'Deployment changed during publication');
        }
        deployment = current;
      } else {
        deployment = ready;
      }
    }

    if (!wasReady) {
      await this.auditService.log({
        userId: deployment.createdById,
        action: 'page_deployment.ready',
        resourceType: 'page_deployment',
        resourceId: deployment.id,
        details: {
          projectId: deployment.projectId,
          publicSlug: deployment.publicSlug,
          sequence: deployment.sequence,
        },
      });
      this.eventBus?.publish(
        PAGE_EVENT_CHANNELS.deployment,
        pageProjectEvent(deployment.projectId, 'ready', {
          id: deployment.id,
          deploymentId: deployment.id,
          publicSlug: deployment.publicSlug,
          sequence: deployment.sequence,
          status: 'ready',
        })
      );
    }

    const latest = await this.tagService.beginActivation(
      deployment.projectId,
      'latest',
      deployment.id,
      deployment.createdById,
      { systemLatest: true }
    );
    if (latest) await this.publishTag(latest);
    if (deployment.requestedTag) {
      const requested = await this.tagService.beginActivation(
        deployment.projectId,
        deployment.requestedTag,
        deployment.id,
        deployment.createdById
      );
      if (requested) await this.publishTag(requested);
    }
  }

  private async publishTag(request: PageTagActivationRequest): Promise<boolean> {
    let progress: Record<string, unknown> = {};
    try {
      await this.tagService.markStaging(request.id);
      progress = await this.adapter.stage(request);
      await this.tagService.markStaging(request.id, progress);
      const completed = await this.tagService.completeActivation(request);
      if (!completed) {
        try {
          await this.adapter.rollback?.(request, progress);
        } catch {
          await this.tagService.failActivation(request, 'PAGE_TAG_ROLLBACK_FAILED');
          throw new AppError(500, 'PAGE_TAG_ROLLBACK_FAILED', 'Tag publication rollback failed');
        }
      }
      return completed;
    } catch (error) {
      if (error instanceof AppError && error.code === 'PAGE_TAG_ROLLBACK_FAILED') throw error;
      await this.tagService.markRollingBack(request.id, progress);
      try {
        await this.adapter.rollback?.(request, progress);
      } catch {
        await this.tagService.failActivation(request, 'PAGE_TAG_ROLLBACK_FAILED');
        throw new AppError(500, 'PAGE_TAG_ROLLBACK_FAILED', 'Tag publication rollback failed');
      }
      await this.tagService.failActivation(request, publicFailureCode(error));
      throw error instanceof AppError
        ? error
        : new AppError(500, 'PAGE_TAG_PUBLICATION_FAILED', 'Tag publication failed');
    }
  }
}
