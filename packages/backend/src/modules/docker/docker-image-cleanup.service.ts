import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerImageCleanupSettings } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { DockerManagementService } from './docker.service.js';
import type { ImageCleanupUpsertInput } from './docker-image-cleanup.schemas.js';

const logger = createChildLogger('DockerImageCleanupService');

type CleanupRow = typeof dockerImageCleanupSettings.$inferSelect;

export type DockerImageCleanupSettingsDto =
  | CleanupRow
  | {
      id: null;
      nodeId: string;
      targetType: 'container' | 'deployment';
      containerName: string | null;
      deploymentId: string | null;
      enabled: boolean;
      retentionCount: number;
      createdAt: null;
      updatedAt: null;
    };

export class DockerImageCleanupService {
  private eventBus?: EventBusService;

  constructor(
    private db: DrizzleClient,
    private docker: DockerManagementService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  async getForContainer(nodeId: string, containerName: string): Promise<DockerImageCleanupSettingsDto> {
    const [row] = await this.db
      .select()
      .from(dockerImageCleanupSettings)
      .where(
        and(
          eq(dockerImageCleanupSettings.nodeId, nodeId),
          eq(dockerImageCleanupSettings.targetType, 'container'),
          eq(dockerImageCleanupSettings.containerName, containerName)
        )
      )
      .limit(1);
    return (
      row ?? {
        id: null,
        nodeId,
        targetType: 'container',
        containerName,
        deploymentId: null,
        enabled: false,
        retentionCount: 2,
        createdAt: null,
        updatedAt: null,
      }
    );
  }

  async upsertForContainer(
    nodeId: string,
    containerName: string,
    input: ImageCleanupUpsertInput
  ): Promise<DockerImageCleanupSettingsDto> {
    const existing = await this.getPersistedForContainer(nodeId, containerName);
    if (existing) {
      const [updated] = await this.db
        .update(dockerImageCleanupSettings)
        .set({
          enabled: input.enabled ?? existing.enabled,
          retentionCount: input.retentionCount ?? existing.retentionCount,
          updatedAt: new Date(),
        })
        .where(eq(dockerImageCleanupSettings.id, existing.id))
        .returning();
      this.emit('updated', updated);
      return updated;
    }

    const [created] = await this.db
      .insert(dockerImageCleanupSettings)
      .values({
        nodeId,
        targetType: 'container',
        containerName,
        enabled: input.enabled ?? false,
        retentionCount: input.retentionCount ?? 2,
      })
      .returning();
    this.emit('created', created);
    return created;
  }

  async getForDeployment(nodeId: string, deploymentId: string): Promise<DockerImageCleanupSettingsDto> {
    const [row] = await this.db
      .select()
      .from(dockerImageCleanupSettings)
      .where(
        and(
          eq(dockerImageCleanupSettings.nodeId, nodeId),
          eq(dockerImageCleanupSettings.targetType, 'deployment'),
          eq(dockerImageCleanupSettings.deploymentId, deploymentId)
        )
      )
      .limit(1);
    return (
      row ?? {
        id: null,
        nodeId,
        targetType: 'deployment',
        containerName: null,
        deploymentId,
        enabled: false,
        retentionCount: 2,
        createdAt: null,
        updatedAt: null,
      }
    );
  }

  async upsertForDeployment(
    nodeId: string,
    deploymentId: string,
    input: ImageCleanupUpsertInput
  ): Promise<DockerImageCleanupSettingsDto> {
    const existing = await this.getPersistedForDeployment(nodeId, deploymentId);
    if (existing) {
      const [updated] = await this.db
        .update(dockerImageCleanupSettings)
        .set({
          enabled: input.enabled ?? existing.enabled,
          retentionCount: input.retentionCount ?? existing.retentionCount,
          updatedAt: new Date(),
        })
        .where(eq(dockerImageCleanupSettings.id, existing.id))
        .returning();
      this.emit('updated', updated);
      return updated;
    }

    const [created] = await this.db
      .insert(dockerImageCleanupSettings)
      .values({
        nodeId,
        targetType: 'deployment',
        deploymentId,
        enabled: input.enabled ?? false,
        retentionCount: input.retentionCount ?? 2,
      })
      .returning();
    this.emit('created', created);
    return created;
  }

  async scheduleCleanupForContainer(nodeId: string, containerName: string, imageRef: string | undefined) {
    const image = imageRef?.trim();
    if (!image) return;
    const { imageName } = parseImageRef(image);

    try {
      const settings = await this.getForContainer(nodeId, containerName);
      await this.scheduleCleanup(nodeId, imageName, settings);
    } catch (err) {
      logger.warn('Image cleanup scheduling failed', {
        nodeId,
        containerName,
        imageName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async scheduleCleanupForDeployment(nodeId: string, deploymentId: string, imageRef: string | undefined) {
    const image = imageRef?.trim();
    if (!image) return;
    const { imageName } = parseImageRef(image);

    try {
      const settings = await this.getForDeployment(nodeId, deploymentId);
      await this.scheduleCleanup(nodeId, imageName, settings);
    } catch (err) {
      logger.warn('Deployment image cleanup scheduling failed', {
        nodeId,
        deploymentId,
        imageName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async getPersistedForContainer(nodeId: string, containerName: string): Promise<CleanupRow | null> {
    const [row] = await this.db
      .select()
      .from(dockerImageCleanupSettings)
      .where(
        and(
          eq(dockerImageCleanupSettings.nodeId, nodeId),
          eq(dockerImageCleanupSettings.targetType, 'container'),
          eq(dockerImageCleanupSettings.containerName, containerName)
        )
      )
      .limit(1);
    return row ?? null;
  }

  private async getPersistedForDeployment(nodeId: string, deploymentId: string): Promise<CleanupRow | null> {
    const [row] = await this.db
      .select()
      .from(dockerImageCleanupSettings)
      .where(
        and(
          eq(dockerImageCleanupSettings.nodeId, nodeId),
          eq(dockerImageCleanupSettings.targetType, 'deployment'),
          eq(dockerImageCleanupSettings.deploymentId, deploymentId)
        )
      )
      .limit(1);
    return row ?? null;
  }

  private async scheduleCleanup(nodeId: string, imageName: string, settings: DockerImageCleanupSettingsDto) {
    if (!settings.enabled) return;
    await new Promise((r) => setTimeout(r, 5000));
    await this.performCleanup(nodeId, imageName, settings.retentionCount);
  }

  private async performCleanup(nodeId: string, imageName: string, retentionCount: number) {
    try {
      const images = await this.docker.listImages(nodeId);
      if (!Array.isArray(images)) return;

      const matching: Array<{ id: string; tag: string; created: number }> = [];
      for (const img of images) {
        const tags: string[] = img.RepoTags ?? img.repoTags ?? [];
        for (const tag of tags) {
          const colonIdx = tag.lastIndexOf(':');
          if (colonIdx === -1) continue;
          const tagImageName = tag.slice(0, colonIdx);
          if (normalizeImageName(tagImageName) === normalizeImageName(imageName)) {
            matching.push({
              id: img.Id ?? img.id,
              tag,
              created: img.Created ?? img.created ?? 0,
            });
          }
        }
      }

      if (matching.length <= retentionCount) return;

      const containers = await this.docker.listAllContainers(nodeId);
      const inUseImageIds = new Set<string>();
      if (Array.isArray(containers)) {
        for (const container of containers) {
          if (container.ImageID) inUseImageIds.add(container.ImageID);
          if (container.imageId) inUseImageIds.add(container.imageId);
        }
      }

      matching.sort((a, b) => b.created - a.created);
      const toRemove = matching.slice(retentionCount);

      for (const img of toRemove) {
        if (inUseImageIds.has(img.id)) {
          logger.debug('Skipping cleanup of in-use image', { imageId: img.id, tag: img.tag });
          continue;
        }
        await this.docker.removeImage(nodeId, img.id, false, 'system').catch((err) => {
          logger.warn('Failed to remove old image', {
            nodeId,
            imageId: img.id,
            tag: img.tag,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      logger.warn('Image cleanup failed', {
        nodeId,
        imageName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private emit(action: 'created' | 'updated', settings: DockerImageCleanupSettingsDto) {
    this.eventBus?.publish('docker.image-cleanup.changed', {
      action,
      id: settings.id,
      nodeId: settings.nodeId,
      targetType: settings.targetType,
      containerName: settings.containerName,
      deploymentId: settings.deploymentId,
      enabled: settings.enabled,
      retentionCount: settings.retentionCount,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
    });
  }
}

function parseImageRef(ref: string): { imageName: string; currentTag: string } {
  const lastColon = ref.lastIndexOf(':');
  const lastSlash = ref.lastIndexOf('/');
  if (lastColon === -1 || lastSlash > lastColon) {
    return { imageName: ref, currentTag: 'latest' };
  }
  return { imageName: ref.slice(0, lastColon), currentTag: ref.slice(lastColon + 1) };
}

function normalizeImageName(name: string): string {
  return name
    .replace(/^docker\.io\/library\//, '')
    .replace(/^index\.docker\.io\/library\//, '')
    .replace(/^docker\.io\//, '')
    .replace(/^index\.docker\.io\//, '')
    .replace(/^library\//, '');
}
