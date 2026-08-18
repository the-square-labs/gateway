import { and, eq, inArray, lt } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { pageDeployments, pageUploadSessions } from '@/db/schema/index.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { PageArtifactStore } from '../artifacts/page-artifact-store.js';
import { PAGE_EVENT_CHANNELS, pageProjectEvent } from '../page-events.js';
import type { PageRetentionService } from './page-retention.service.js';

export class PageMaintenanceService {
  private running = false;
  private migrationReconciler?: { reconcileMigrations(): Promise<number> };

  constructor(
    private readonly db: DrizzleClient,
    private readonly store: PageArtifactStore,
    private readonly retentionService: PageRetentionService,
    private readonly eventBus: EventBusService
  ) {}

  setMigrationReconciler(reconciler: { reconcileMigrations(): Promise<number> }): void {
    this.migrationReconciler = reconciler;
  }

  async run(): Promise<{ itemsCleaned: number; spaceFreedBytes: number }> {
    if (this.running) return { itemsCleaned: 0, spaceFreedBytes: 0 };
    this.running = true;
    try {
      const expired = await this.expireUploads();
      const migrations = (await this.migrationReconciler?.reconcileMigrations()) ?? 0;
      const retention = await this.retentionService.runAll();
      return {
        itemsCleaned: expired + migrations + retention.itemsCleaned,
        spaceFreedBytes: retention.spaceFreedBytes,
      };
    } finally {
      this.running = false;
    }
  }

  private async expireUploads(): Promise<number> {
    const rows = await this.db
      .select({ session: pageUploadSessions, deployment: pageDeployments })
      .from(pageUploadSessions)
      .innerJoin(pageDeployments, eq(pageUploadSessions.deploymentId, pageDeployments.id))
      .where(
        and(
          inArray(pageUploadSessions.status, ['open', 'finalizing', 'expired']),
          lt(pageUploadSessions.expiresAt, new Date())
        )
      );
    let cleaned = 0;
    for (const row of rows) {
      const expired =
        row.session.status === 'expired'
          ? true
          : await this.db.transaction(async (tx) => {
              const [session] = await tx
                .update(pageUploadSessions)
                .set({ status: 'expired', failureCode: 'PAGES_UPLOAD_EXPIRED', updatedAt: new Date() })
                .where(
                  and(
                    eq(pageUploadSessions.id, row.session.id),
                    inArray(pageUploadSessions.status, ['open', 'finalizing'])
                  )
                )
                .returning({ id: pageUploadSessions.id });
              if (!session) return false;
              await tx
                .update(pageDeployments)
                .set({
                  status: 'failed',
                  failureCode: 'PAGES_UPLOAD_EXPIRED',
                  failureMessage: 'Deployment upload expired',
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(pageDeployments.id, row.deployment.id),
                    inArray(pageDeployments.status, ['uploading', 'validating'])
                  )
                );
              return true;
            });
      if (!expired) continue;
      await this.store.remove(row.session.tempKey);
      cleaned += 1;
      if (row.session.status === 'expired') continue;
      this.eventBus.publish(
        PAGE_EVENT_CHANNELS.deployment,
        pageProjectEvent(row.deployment.projectId, 'failed', {
          id: row.deployment.id,
          deploymentId: row.deployment.id,
          publicSlug: row.deployment.publicSlug,
          status: 'failed',
          failureCode: 'PAGES_UPLOAD_EXPIRED',
        })
      );
    }
    return cleaned;
  }
}
