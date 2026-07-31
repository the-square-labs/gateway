import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerContainerFolderAssignments,
  dockerDeploymentSlots,
  dockerDeployments,
  dockerEnvVars,
  dockerHealthChecks,
  dockerImageCleanupSettings,
  dockerMigrations,
  dockerRuntimeSettings,
  dockerSecrets,
  dockerWebhooks,
  nodes,
  proxyHosts,
} from '@/db/schema/index.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { DockerAccessResourceService } from './docker-access-resource.service.js';
import { migrationPlan } from './docker-migration-runtime.js';
import type { DockerSnapshotReconciler } from './docker-snapshot-reconciler.service.js';

type MigrationRow = typeof dockerMigrations.$inferSelect;
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export class DockerMigrationCoordinator {
  constructor(
    private db: DrizzleClient,
    private proxy: ProxyService,
    private snapshots: DockerSnapshotReconciler,
    private accessResources: DockerAccessResourceService
  ) {}

  async enterMaintenance(row: MigrationRow): Promise<void> {
    const snapshot = row.proxySnapshot as {
      hosts?: Array<{ id: string; enabled: boolean; maintenanceAlreadyEnabled: boolean }>;
    };
    const entered: string[] = [];
    try {
      for (const host of snapshot.hosts ?? []) {
        if (!host.enabled || host.maintenanceAlreadyEnabled) continue;
        await this.proxy.toggleMaintenance(host.id, true, row.createdById ?? SYSTEM_USER_ID);
        entered.push(host.id);
      }
    } catch (error) {
      for (const hostId of entered.reverse()) {
        await this.proxy.toggleMaintenance(hostId, false, row.createdById ?? SYSTEM_USER_ID).catch(() => undefined);
      }
      throw error;
    }
    await this.db
      .update(dockerMigrations)
      .set({ proxySnapshot: { ...snapshot, migrationEnteredMaintenance: entered }, updatedAt: new Date() })
      .where(eq(dockerMigrations.id, row.id));
  }

  async cutoverMetadata(row: MigrationRow): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [targetNode] = await tx
        .select({ slug: nodes.slug })
        .from(nodes)
        .where(eq(nodes.id, row.targetNodeId))
        .limit(1);
      if (!targetNode) throw new Error('Target Docker node no longer exists');
      const storedPlan = migrationPlan(row);
      const activeSlot = storedPlan.deploymentActiveSlot || storedPlan.deployment?.activeSlot;
      if (row.resourceType === 'deployment') {
        const target = storedPlan.target;
        await tx
          .update(dockerDeployments)
          .set({ nodeId: row.targetNodeId, updatedAt: new Date() })
          .where(eq(dockerDeployments.id, row.deploymentId!));
        await tx
          .update(dockerHealthChecks)
          .set({ nodeId: row.targetNodeId, updatedAt: new Date() })
          .where(eq(dockerHealthChecks.deploymentId, row.deploymentId!));
        await tx
          .update(dockerWebhooks)
          .set({ nodeId: row.targetNodeId, updatedAt: new Date() })
          .where(eq(dockerWebhooks.deploymentId, row.deploymentId!));
        await tx
          .update(dockerImageCleanupSettings)
          .set({ nodeId: row.targetNodeId, updatedAt: new Date() })
          .where(eq(dockerImageCleanupSettings.deploymentId, row.deploymentId!));
        for (const slot of ['blue', 'green'] as const) {
          const containerId = target?.[`${slot}ContainerId`];
          if (!containerId) continue;
          await tx
            .update(dockerDeploymentSlots)
            .set({
              containerId,
              status: row.sourceState === 'ready' ? (slot === activeSlot ? 'running' : 'created') : 'stopped',
              health: row.sourceState === 'ready' && slot === activeSlot ? 'healthy' : 'unknown',
              updatedAt: new Date(),
            })
            .where(
              and(eq(dockerDeploymentSlots.deploymentId, row.deploymentId!), eq(dockerDeploymentSlots.slot, slot))
            );
        }
        await this.accessResources.moveDeploymentWithExecutor(
          tx,
          row.sourceNodeId,
          row.targetNodeId,
          row.deploymentId!
        );
      }

      const metadataName = row.resourceType === 'deployment' ? `deployment:${row.deploymentId}` : row.resourceName;
      await tx
        .update(dockerEnvVars)
        .set({ nodeId: row.targetNodeId, updatedAt: new Date() })
        .where(and(eq(dockerEnvVars.nodeId, row.sourceNodeId), eq(dockerEnvVars.containerName, metadataName)));
      await tx
        .update(dockerSecrets)
        .set({ nodeId: row.targetNodeId, updatedAt: new Date() })
        .where(and(eq(dockerSecrets.nodeId, row.sourceNodeId), eq(dockerSecrets.containerName, metadataName)));

      if (row.resourceType === 'container') {
        await this.moveStandaloneMetadata(tx, row);
        await this.accessResources.moveContainerWithExecutor(
          tx,
          row.sourceNodeId,
          row.targetNodeId,
          row.resourceName,
          storedPlan.target?.containerId
        );
      }
      await tx
        .update(dockerMigrations)
        .set({
          cutoverAt: new Date(),
          plan: { ...storedPlan, targetNodeSlug: targetNode.slug },
          updatedAt: new Date(),
        })
        .where(eq(dockerMigrations.id, row.id));
    });
    await this.refreshTargetSnapshots(row);
  }

  async refreshTargetSnapshots(row: MigrationRow): Promise<void> {
    await this.refreshNodeSnapshots(row.targetNodeId);
    if (row.resourceType === 'container') {
      await this.snapshots.refreshNow(row.targetNodeId, 'container-detail', row.resourceName);
    }
  }

  refreshSourceSnapshots(row: MigrationRow): Promise<void> {
    return this.refreshNodeSnapshots(row.sourceNodeId);
  }

  async exitEnteredMaintenance(row: MigrationRow): Promise<void> {
    const [fresh] = await this.db
      .select({ proxySnapshot: dockerMigrations.proxySnapshot })
      .from(dockerMigrations)
      .where(eq(dockerMigrations.id, row.id));
    const snapshot = fresh?.proxySnapshot as { migrationEnteredMaintenance?: string[] } | undefined;
    for (const hostId of snapshot?.migrationEnteredMaintenance ?? []) {
      await this.proxy.toggleMaintenance(hostId, false, row.createdById ?? SYSTEM_USER_ID);
    }
  }

  private async moveStandaloneMetadata(
    tx: Parameters<Parameters<DrizzleClient['transaction']>[0]>[0],
    row: MigrationRow
  ) {
    await tx
      .update(dockerRuntimeSettings)
      .set({ nodeId: row.targetNodeId, updatedAt: new Date() })
      .where(
        and(
          eq(dockerRuntimeSettings.nodeId, row.sourceNodeId),
          eq(dockerRuntimeSettings.containerName, row.resourceName)
        )
      );
    await tx
      .update(dockerHealthChecks)
      .set({ nodeId: row.targetNodeId, updatedAt: new Date() })
      .where(
        and(eq(dockerHealthChecks.nodeId, row.sourceNodeId), eq(dockerHealthChecks.containerName, row.resourceName))
      );
    await tx
      .update(dockerWebhooks)
      .set({ nodeId: row.targetNodeId, updatedAt: new Date() })
      .where(and(eq(dockerWebhooks.nodeId, row.sourceNodeId), eq(dockerWebhooks.containerName, row.resourceName)));
    await tx
      .update(dockerImageCleanupSettings)
      .set({ nodeId: row.targetNodeId, updatedAt: new Date() })
      .where(
        and(
          eq(dockerImageCleanupSettings.nodeId, row.sourceNodeId),
          eq(dockerImageCleanupSettings.containerName, row.resourceName)
        )
      );
    await tx
      .update(dockerContainerFolderAssignments)
      .set({ nodeId: row.targetNodeId, folderId: null, updatedAt: new Date() })
      .where(
        and(
          eq(dockerContainerFolderAssignments.nodeId, row.sourceNodeId),
          eq(dockerContainerFolderAssignments.containerName, row.resourceName)
        )
      );
    await tx
      .update(proxyHosts)
      .set({ dockerNodeId: row.targetNodeId, updatedAt: new Date() })
      .where(
        and(
          eq(proxyHosts.upstreamKind, 'docker_container'),
          eq(proxyHosts.dockerNodeId, row.sourceNodeId),
          eq(proxyHosts.dockerContainerName, row.resourceName)
        )
      );
  }

  private async refreshNodeSnapshots(nodeId: string): Promise<void> {
    await Promise.all([this.snapshots.refreshNow(nodeId, 'containers'), this.snapshots.refreshNow(nodeId, 'volumes')]);
  }
}
