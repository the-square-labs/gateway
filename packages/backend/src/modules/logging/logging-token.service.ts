import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { loggingEnvironments, loggingIngestTokens, loggingSchemas } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { type LicensePolicyService, requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { CreateLoggingTokenInput } from './logging.schemas.js';

export function hashLoggingToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export class LoggingTokenService {
  private licensePolicy?: LicensePolicyService;
  private eventBus?: EventBusService;
  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService
  ) {}

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicy = service;
  }

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  async list(environmentId: string) {
    const tokens = await this.db
      .select()
      .from(loggingIngestTokens)
      .where(eq(loggingIngestTokens.environmentId, environmentId))
      .orderBy(desc(loggingIngestTokens.createdAt));
    return tokens.map((token) => ({
      id: token.id,
      environmentId: token.environmentId,
      name: token.name,
      tokenPrefix: token.tokenPrefix,
      enabled: token.enabled,
      lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
      expiresAt: token.expiresAt?.toISOString() ?? null,
      createdById: token.createdById,
      createdAt: token.createdAt.toISOString(),
    }));
  }

  async create(environmentId: string, input: CreateLoggingTokenInput, userId: string) {
    await requireConfiguredLicensePolicy(this.licensePolicy).requireFeature('structured-logging');
    await this.ensureEnvironment(environmentId);
    const raw = `gwl_${randomBytes(32).toString('hex')}`;
    const [token] = await this.db
      .insert(loggingIngestTokens)
      .values({
        environmentId,
        name: input.name,
        tokenHash: hashLoggingToken(raw),
        tokenPrefix: raw.slice(0, 14),
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdById: userId,
      })
      .returning();
    await this.auditService.log({
      userId,
      action: 'logging.token.create',
      resourceType: 'logging-token',
      resourceId: token.id,
      details: { environmentId, name: token.name, tokenPrefix: token.tokenPrefix },
    });
    this.eventBus?.publish('logging.token.changed', { action: 'create', id: token.id, environmentId });
    return {
      id: token.id,
      environmentId: token.environmentId,
      name: token.name,
      tokenPrefix: token.tokenPrefix,
      enabled: token.enabled,
      lastUsedAt: null,
      expiresAt: token.expiresAt?.toISOString() ?? null,
      createdById: token.createdById,
      createdAt: token.createdAt.toISOString(),
      token: raw,
    };
  }

  async delete(environmentId: string, tokenId: string, userId: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(loggingIngestTokens)
      .where(and(eq(loggingIngestTokens.environmentId, environmentId), eq(loggingIngestTokens.id, tokenId)))
      .limit(1);
    const token = rows[0];
    if (!token) throw new AppError(404, 'LOGGING_TOKEN_NOT_FOUND', 'Logging ingest token not found');
    await this.db.delete(loggingIngestTokens).where(eq(loggingIngestTokens.id, tokenId));
    await this.auditService.log({
      userId,
      action: 'logging.token.delete',
      resourceType: 'logging-token',
      resourceId: tokenId,
      details: { environmentId, name: token.name, tokenPrefix: token.tokenPrefix },
    });
    this.eventBus?.publish('logging.token.changed', { action: 'delete', id: tokenId, environmentId });
  }

  async validate(rawToken: string) {
    if (!/^gwl_[0-9a-f]{64}$/.test(rawToken)) return null;
    const rows = await this.db
      .select({
        token: loggingIngestTokens,
        environment: loggingEnvironments,
        schema: loggingSchemas,
      })
      .from(loggingIngestTokens)
      .innerJoin(loggingEnvironments, eq(loggingIngestTokens.environmentId, loggingEnvironments.id))
      .leftJoin(loggingSchemas, eq(loggingEnvironments.schemaId, loggingSchemas.id))
      .where(eq(loggingIngestTokens.tokenHash, hashLoggingToken(rawToken)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (!row.token.enabled || !row.environment.enabled) return null;
    if (row.token.expiresAt && row.token.expiresAt.getTime() <= Date.now()) return null;
    this.db
      .update(loggingIngestTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(loggingIngestTokens.id, row.token.id))
      .execute()
      .catch(() => {});
    return {
      tokenId: row.token.id,
      environmentId: row.environment.id,
      tokenPrefix: row.token.tokenPrefix,
      environment: {
        id: row.environment.id,
        enabled: row.environment.enabled,
        schemaMode: row.schema?.schemaMode ?? 'loose',
        retentionDays: row.environment.retentionDays,
        fieldSchema: row.schema?.fieldSchema ?? [],
        rateLimitRequestsPerWindow: row.environment.rateLimitRequestsPerWindow,
        rateLimitEventsPerWindow: row.environment.rateLimitEventsPerWindow,
      },
    };
  }

  private async ensureEnvironment(environmentId: string): Promise<void> {
    const rows = await this.db
      .select({ id: loggingEnvironments.id })
      .from(loggingEnvironments)
      .where(eq(loggingEnvironments.id, environmentId))
      .limit(1);
    if (!rows[0]) throw new AppError(404, 'LOGGING_ENVIRONMENT_NOT_FOUND', 'Logging environment not found');
  }
}
