import { and, asc, eq, ilike, inArray, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { type LoggingFieldDefinition, loggingEnvironments, loggingSchemas } from '@/db/schema/index.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { type LicensePolicyService, requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { CreateLoggingEnvironmentInput, UpdateLoggingEnvironmentInput } from './logging.schemas.js';
import type { LoggingClickHouseService } from './logging-clickhouse.service.js';
import type { LoggingEnvironmentView } from './logging-storage.types.js';

export class LoggingEnvironmentService {
  private eventBus?: EventBusService;
  private licensePolicy?: LicensePolicyService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly hardCeilings: { requests: number; events: number },
    private readonly storage?: Pick<LoggingClickHouseService, 'deleteEnvironmentLogs'>
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicy = service;
  }

  async list(query?: { search?: string; allowedIds?: string[] }): Promise<LoggingEnvironmentView[]> {
    const search = query?.search?.trim();
    if (query?.allowedIds?.length === 0) return [];
    const searchFilter = search
      ? or(ilike(loggingEnvironments.name, `%${search}%`), ilike(loggingEnvironments.slug, `%${search}%`))
      : undefined;
    const allowedFilter = query?.allowedIds ? inArray(loggingEnvironments.id, query.allowedIds) : undefined;
    const rows = await this.db
      .select({ environment: loggingEnvironments, schema: loggingSchemas })
      .from(loggingEnvironments)
      .leftJoin(loggingSchemas, eq(loggingEnvironments.schemaId, loggingSchemas.id))
      .where(and(allowedFilter, searchFilter))
      .orderBy(asc(loggingEnvironments.sortOrder), asc(loggingEnvironments.name));
    return rows.map((row) => toView(row.environment, row.schema));
  }

  async get(id: string): Promise<LoggingEnvironmentView> {
    const row = await this.findRawWithSchema(id);
    if (!row) throw new AppError(404, 'LOGGING_ENVIRONMENT_NOT_FOUND', 'Logging environment not found');
    return toView(row.environment, row.schema);
  }

  async getBySlug(slug: string): Promise<LoggingEnvironmentView> {
    const rows = await this.db
      .select({ environment: loggingEnvironments, schema: loggingSchemas })
      .from(loggingEnvironments)
      .leftJoin(loggingSchemas, eq(loggingEnvironments.schemaId, loggingSchemas.id))
      .where(eq(loggingEnvironments.slug, slug))
      .limit(1);
    const row = rows[0];
    if (!row) throw new AppError(404, 'LOGGING_ENVIRONMENT_NOT_FOUND', 'Logging environment not found');
    return toView(row.environment, row.schema);
  }

  async create(input: CreateLoggingEnvironmentInput, userId: string): Promise<LoggingEnvironmentView> {
    await requireConfiguredLicensePolicy(this.licensePolicy).requireFeature('structured-logging');
    this.validateLimits(input);
    const row = await writeWithAllocatedSlug({
      source: input.name,
      fallback: 'logging-environment',
      constraint: 'logging_environments_slug_unique',
      write: async (slug) => {
        const [created] = await this.db
          .insert(loggingEnvironments)
          .values({
            ...input,
            slug,
            description: input.description ?? null,
            schemaId: input.schemaId ?? null,
            rateLimitRequestsPerWindow: input.rateLimitRequestsPerWindow ?? null,
            rateLimitEventsPerWindow: input.rateLimitEventsPerWindow ?? null,
            createdById: userId,
          })
          .returning();
        return created;
      },
    });
    await this.auditService.log({
      userId,
      action: 'logging.environment.create',
      resourceType: 'logging-environment',
      resourceId: row.id,
      details: { name: row.name, slug: row.slug },
    });
    this.eventBus?.publish('logging.environment.changed', { action: 'create', id: row.id });
    return this.get(row.id);
  }

  async update(id: string, input: UpdateLoggingEnvironmentInput, userId: string): Promise<LoggingEnvironmentView> {
    this.validateLimits(input);
    const existing = await this.findRaw(id);
    if (!existing) throw new AppError(404, 'LOGGING_ENVIRONMENT_NOT_FOUND', 'Logging environment not found');
    const updateData = {
      ...input,
      description: input.description === undefined ? undefined : input.description,
      schemaId: input.schemaId === undefined ? undefined : input.schemaId,
      rateLimitRequestsPerWindow:
        input.rateLimitRequestsPerWindow === undefined ? undefined : input.rateLimitRequestsPerWindow,
      rateLimitEventsPerWindow:
        input.rateLimitEventsPerWindow === undefined ? undefined : input.rateLimitEventsPerWindow,
      updatedAt: new Date(),
    };
    const updateEnvironment = async (slug?: string) => {
      const [updated] = await this.db
        .update(loggingEnvironments)
        .set({ ...updateData, ...(slug === undefined ? {} : { slug }) })
        .where(eq(loggingEnvironments.id, id))
        .returning();
      return updated;
    };
    const row =
      input.name !== undefined && input.name !== existing.name
        ? await writeWithAllocatedSlug({
            source: input.name,
            fallback: 'logging-environment',
            constraint: 'logging_environments_slug_unique',
            write: updateEnvironment,
          })
        : await updateEnvironment();
    await this.auditService.log({
      userId,
      action: 'logging.environment.update',
      resourceType: 'logging-environment',
      resourceId: id,
      details: { name: row.name, slug: row.slug },
    });
    this.eventBus?.publish('logging.environment.changed', {
      action: 'update',
      id,
      ...(row.slug === existing.slug ? {} : { oldSlug: existing.slug, slug: row.slug }),
    });
    return this.get(row.id);
  }

  async delete(id: string, userId: string): Promise<void> {
    const existing = await this.findRaw(id);
    if (!existing) throw new AppError(404, 'LOGGING_ENVIRONMENT_NOT_FOUND', 'Logging environment not found');
    await this.db
      .update(loggingEnvironments)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(loggingEnvironments.id, id));
    try {
      await this.storage?.deleteEnvironmentLogs(id);
    } catch (error) {
      await this.db
        .update(loggingEnvironments)
        .set({ enabled: existing.enabled, updatedAt: new Date() })
        .where(eq(loggingEnvironments.id, id));
      throw error;
    }
    await this.db.delete(loggingEnvironments).where(eq(loggingEnvironments.id, id));
    await this.auditService.log({
      userId,
      action: 'logging.environment.delete',
      resourceType: 'logging-environment',
      resourceId: id,
      details: { name: existing.name, slug: existing.slug },
    });
    this.eventBus?.publish('logging.environment.changed', { action: 'delete', id });
  }

  async getEnabledForToken(environmentId: string) {
    const row = await this.findRaw(environmentId);
    if (!row?.enabled) return null;
    return toView(row, null);
  }

  private async findRaw(id: string) {
    const rows = await this.db.select().from(loggingEnvironments).where(eq(loggingEnvironments.id, id)).limit(1);
    return rows[0] ?? null;
  }

  private async findRawWithSchema(id: string) {
    const rows = await this.db
      .select({ environment: loggingEnvironments, schema: loggingSchemas })
      .from(loggingEnvironments)
      .leftJoin(loggingSchemas, eq(loggingEnvironments.schemaId, loggingSchemas.id))
      .where(eq(loggingEnvironments.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  private validateLimits(input: Partial<CreateLoggingEnvironmentInput>): void {
    if (input.rateLimitRequestsPerWindow != null && input.rateLimitRequestsPerWindow > this.hardCeilings.requests) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Environment request limit exceeds the global ceiling');
    }
    if (input.rateLimitEventsPerWindow != null && input.rateLimitEventsPerWindow > this.hardCeilings.events) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Environment event limit exceeds the global ceiling');
    }
  }
}

function toView(
  row: typeof loggingEnvironments.$inferSelect,
  schema: typeof loggingSchemas.$inferSelect | null
): LoggingEnvironmentView {
  const hasSchema = schema !== null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    enabled: row.enabled,
    schemaId: hasSchema ? row.schemaId : null,
    schemaName: schema?.name ?? null,
    schemaMode: schema?.schemaMode ?? 'loose',
    retentionDays: row.retentionDays,
    rateLimitRequestsPerWindow: row.rateLimitRequestsPerWindow,
    rateLimitEventsPerWindow: row.rateLimitEventsPerWindow,
    fieldSchema: (schema?.fieldSchema ?? []) as LoggingFieldDefinition[],
    folderId: row.folderId,
    sortOrder: row.sortOrder,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
