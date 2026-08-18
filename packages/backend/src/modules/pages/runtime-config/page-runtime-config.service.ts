import { Buffer } from 'node:buffer';
import { and, eq, isNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { pageProjects, pageRuntimeConfigs, pageTags } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { PAGE_EVENT_CHANNELS, pageProjectEvent } from '../page-events.js';
import { PAGE_RUNTIME_CONFIG_MAX_BYTES, type SavePageRuntimeConfigInput } from './page-runtime-config.schemas.js';

type RuntimeConfigRow = typeof pageRuntimeConfigs.$inferSelect;

export interface PageRuntimeConfigPublicationRequest {
  projectId: string;
  tagId: string | null;
  value: Record<string, unknown>;
  sourceGeneration: number;
  action: 'save' | 'reset';
}

export interface PageRuntimeConfigPublicationAdapter {
  publishRuntimeConfig(request: PageRuntimeConfigPublicationRequest): Promise<void>;
}

const NOOP_PUBLICATION_ADAPTER: PageRuntimeConfigPublicationAdapter = {
  publishRuntimeConfig: async () => undefined,
};

const DEFAULT_RUNTIME_CONFIG_LOCK_PREFIX = 'gateway-pages-default-runtime-config:';

/**
 * Serializes a Default runtime-config mutation (including daemon publication)
 * with a preview's final ready claim across every Gateway process sharing the
 * PostgreSQL database. This must stay a session advisory lock: the protected
 * operation makes several committed database writes and daemon RPCs.
 */
export async function withPageDefaultRuntimeConfigLock<T>(
  db: DrizzleClient,
  projectId: string,
  operation: () => Promise<T>
): Promise<T> {
  const client = await db.$client.connect();
  const key = `${DEFAULT_RUNTIME_CONFIG_LOCK_PREFIX}${projectId}`;
  try {
    await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [key]);
  } catch (lockError) {
    client.release(lockError instanceof Error ? lockError : new Error('Pages runtime config lock acquisition failed'));
    throw lockError;
  }

  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  let unlockError: unknown;
  try {
    await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [key]);
    client.release();
  } catch (error) {
    unlockError = error;
    // Never return a connection with a potentially held session advisory lock
    // to the pool.
    client.release(error instanceof Error ? error : new Error('Pages runtime config lock release failed'));
  }
  if (operationError && unlockError) {
    throw new AggregateError([operationError, unlockError], 'Pages runtime config lock release failed');
  }
  if (unlockError) throw unlockError;
  if (operationError) throw operationError;
  return result as T;
}

export function parsePageRuntimeConfigSource(source: string): Record<string, unknown> {
  if (Buffer.byteLength(source, 'utf8') > PAGE_RUNTIME_CONFIG_MAX_BYTES) {
    throw new AppError(
      413,
      'PAGE_RUNTIME_CONFIG_TOO_LARGE',
      `Runtime configuration must not exceed ${PAGE_RUNTIME_CONFIG_MAX_BYTES} bytes`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new AppError(400, 'PAGE_RUNTIME_CONFIG_INVALID_JSON', 'Runtime configuration must be valid JSON');
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new AppError(400, 'PAGE_RUNTIME_CONFIG_OBJECT_REQUIRED', 'Runtime configuration must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export class PageRuntimeConfigService {
  private eventBus?: EventBusService;
  private publicationAdapter: PageRuntimeConfigPublicationAdapter = NOOP_PUBLICATION_ADAPTER;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  setPublicationAdapter(adapter: PageRuntimeConfigPublicationAdapter): void {
    this.publicationAdapter = adapter;
  }

  async list(projectId: string) {
    await this.assertProject(projectId);
    const [rows, tags] = await Promise.all([
      this.db.select().from(pageRuntimeConfigs).where(eq(pageRuntimeConfigs.projectId, projectId)),
      this.db
        .select({ id: pageTags.id, name: pageTags.name, system: pageTags.system })
        .from(pageTags)
        .where(eq(pageTags.projectId, projectId)),
    ]);
    const defaultConfig = rows.find((row) => row.tagId === null);
    if (!defaultConfig) {
      throw new AppError(500, 'PAGE_RUNTIME_CONFIG_DEFAULT_MISSING', 'Default runtime configuration is missing');
    }
    const serializedDefault = this.serialize(defaultConfig);
    const overrides = rows.filter((row) => row.tagId !== null).map((row) => this.serialize(row));
    const overrideByTagId = new Map(overrides.map((override) => [override.tagId, override]));
    return {
      default: serializedDefault,
      overrides,
      tags: tags
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((tag) => {
          const override = overrideByTagId.get(tag.id) ?? null;
          return {
            ...tag,
            hasOverride: Boolean(override),
            inherited: !override,
            override,
            effective: override ?? serializedDefault,
          };
        }),
    };
  }

  async getEffective(projectId: string, tagId: string | null) {
    const rows = await this.db.select().from(pageRuntimeConfigs).where(eq(pageRuntimeConfigs.projectId, projectId));
    const defaultConfig = rows.find((row) => row.tagId === null);
    if (!defaultConfig) {
      throw new AppError(500, 'PAGE_RUNTIME_CONFIG_DEFAULT_MISSING', 'Default runtime configuration is missing');
    }
    const override = tagId ? rows.find((row) => row.tagId === tagId) : undefined;
    const selected = override ?? defaultConfig;
    return { ...this.serialize(selected), inherited: Boolean(tagId && !override) };
  }

  saveDefault(projectId: string, input: SavePageRuntimeConfigInput, userId: string) {
    return this.withLock(`${projectId}:default`, () =>
      withPageDefaultRuntimeConfigLock(this.db, projectId, () => this.save(projectId, null, input, userId))
    );
  }

  saveTag(projectId: string, tagId: string, input: SavePageRuntimeConfigInput, userId: string) {
    return this.withLock(`${projectId}:tag:${tagId}`, () => this.save(projectId, tagId, input, userId));
  }

  resetTag(projectId: string, tagId: string, expectedGeneration: number, userId: string) {
    return this.withLock(`${projectId}:tag:${tagId}`, async () => {
      const tag = await this.assertTag(projectId, tagId);
      const [override] = await this.db
        .select()
        .from(pageRuntimeConfigs)
        .where(and(eq(pageRuntimeConfigs.projectId, projectId), eq(pageRuntimeConfigs.tagId, tagId)))
        .limit(1);
      if (!override) return this.getEffective(projectId, tagId);
      if (override.generation !== expectedGeneration) {
        throw new AppError(
          409,
          'PAGE_RUNTIME_CONFIG_GENERATION_CONFLICT',
          'Runtime configuration changed concurrently'
        );
      }
      const effectiveDefault = await this.getEffective(projectId, null);
      const removed = await this.db
        .delete(pageRuntimeConfigs)
        .where(and(eq(pageRuntimeConfigs.id, override.id), eq(pageRuntimeConfigs.generation, expectedGeneration)))
        .returning();
      if (removed.length === 0) {
        throw new AppError(
          409,
          'PAGE_RUNTIME_CONFIG_GENERATION_CONFLICT',
          'Runtime configuration changed concurrently'
        );
      }
      try {
        await this.publicationAdapter.publishRuntimeConfig({
          projectId,
          tagId,
          value: effectiveDefault.value,
          sourceGeneration: effectiveDefault.generation,
          action: 'reset',
        });
      } catch (error) {
        await this.db.insert(pageRuntimeConfigs).values(override);
        this.emit(
          projectId,
          'publication.failed',
          tagId,
          override.generation,
          Buffer.byteLength(effectiveDefault.source, 'utf8'),
          error instanceof AppError ? error.code : 'PAGES_RUNTIME_CONFIG_PUBLICATION_FAILED'
        );
        throw error;
      }
      await this.auditService.log({
        userId,
        action: 'page_runtime_config.reset',
        resourceType: 'page_project',
        resourceId: projectId,
        details: { projectId, tagId, tag: tag.name, previousGeneration: override.generation },
      });
      this.emit(
        projectId,
        'reset',
        tagId,
        effectiveDefault.generation,
        Buffer.byteLength(effectiveDefault.source, 'utf8')
      );
      return { ...effectiveDefault, inherited: true };
    });
  }

  private async save(projectId: string, tagId: string | null, input: SavePageRuntimeConfigInput, userId: string) {
    const value = parsePageRuntimeConfigSource(input.source);
    const byteSize = Buffer.byteLength(input.source, 'utf8');
    await this.assertProject(projectId);
    const tag = tagId ? await this.assertTag(projectId, tagId) : null;
    const [existing] = await this.db
      .select()
      .from(pageRuntimeConfigs)
      .where(
        tagId
          ? and(eq(pageRuntimeConfigs.projectId, projectId), eq(pageRuntimeConfigs.tagId, tagId))
          : and(eq(pageRuntimeConfigs.projectId, projectId), isNull(pageRuntimeConfigs.tagId))
      )
      .limit(1);
    if (existing ? existing.generation !== input.expectedGeneration : input.expectedGeneration !== 0) {
      throw new AppError(409, 'PAGE_RUNTIME_CONFIG_GENERATION_CONFLICT', 'Runtime configuration changed concurrently');
    }
    const nextGeneration = (existing?.generation ?? 0) + 1;
    let saved: RuntimeConfigRow | undefined;
    if (existing) {
      [saved] = await this.db
        .update(pageRuntimeConfigs)
        .set({ value, generation: nextGeneration, updatedById: userId, updatedAt: new Date() })
        .where(and(eq(pageRuntimeConfigs.id, existing.id), eq(pageRuntimeConfigs.generation, input.expectedGeneration)))
        .returning();
    } else {
      try {
        [saved] = await this.db
          .insert(pageRuntimeConfigs)
          .values({ projectId, tagId, value, generation: nextGeneration, updatedById: userId })
          .returning();
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
          throw new AppError(
            409,
            'PAGE_RUNTIME_CONFIG_GENERATION_CONFLICT',
            'Runtime configuration changed concurrently'
          );
        }
        throw error;
      }
    }
    if (!saved)
      throw new AppError(409, 'PAGE_RUNTIME_CONFIG_GENERATION_CONFLICT', 'Runtime configuration changed concurrently');
    try {
      await this.publicationAdapter.publishRuntimeConfig({
        projectId,
        tagId,
        value,
        sourceGeneration: saved.generation,
        action: 'save',
      });
    } catch (error) {
      await this.restore(existing, saved);
      this.emit(
        projectId,
        'publication.failed',
        tagId,
        saved.generation,
        byteSize,
        error instanceof AppError ? error.code : 'PAGES_RUNTIME_CONFIG_PUBLICATION_FAILED'
      );
      throw error;
    }
    await this.auditService.log({
      userId,
      action: 'page_runtime_config.update',
      resourceType: 'page_project',
      resourceId: projectId,
      details: {
        projectId,
        tagId,
        tag: tag?.name ?? null,
        generation: saved.generation,
        byteSize,
      },
    });
    this.emit(projectId, 'updated', tagId, saved.generation, byteSize);
    return { ...this.serialize(saved), inherited: false };
  }

  private async restore(previous: RuntimeConfigRow | undefined, saved: RuntimeConfigRow): Promise<void> {
    if (!previous) {
      await this.db.delete(pageRuntimeConfigs).where(eq(pageRuntimeConfigs.id, saved.id));
      return;
    }
    await this.db
      .update(pageRuntimeConfigs)
      .set({
        value: previous.value,
        generation: previous.generation,
        updatedById: previous.updatedById,
        updatedAt: previous.updatedAt,
      })
      .where(and(eq(pageRuntimeConfigs.id, saved.id), eq(pageRuntimeConfigs.generation, saved.generation)));
  }

  private async assertProject(projectId: string): Promise<void> {
    const [project] = await this.db
      .select({ id: pageProjects.id })
      .from(pageProjects)
      .where(eq(pageProjects.id, projectId))
      .limit(1);
    if (!project) throw new AppError(404, 'PAGE_PROJECT_NOT_FOUND', 'Page Project not found');
  }

  private async assertTag(projectId: string, tagId: string) {
    const [tag] = await this.db
      .select({ id: pageTags.id, name: pageTags.name })
      .from(pageTags)
      .where(and(eq(pageTags.id, tagId), eq(pageTags.projectId, projectId)))
      .limit(1);
    if (!tag) throw new AppError(404, 'PAGE_TAG_NOT_FOUND', 'Page Tag not found');
    return tag;
  }

  private serialize(row: RuntimeConfigRow) {
    return {
      id: row.id,
      projectId: row.projectId,
      tagId: row.tagId,
      value: row.value,
      source: JSON.stringify(row.value, null, 2),
      generation: row.generation,
      updatedById: row.updatedById,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private emit(
    projectId: string,
    action: string,
    tagId: string | null,
    generation: number,
    byteSize: number,
    failureCode: string | null = null
  ): void {
    this.eventBus?.publish(
      PAGE_EVENT_CHANNELS.config,
      pageProjectEvent(projectId, action, { id: tagId ?? projectId, tagId, generation, byteSize, failureCode })
    );
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}
