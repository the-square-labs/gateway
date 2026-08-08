import { count, eq, ilike, inArray, type SQL } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { notificationWebhooks } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { CreateWebhookInput, UpdateWebhookInput, WebhookListQuery } from './notification-webhook.schemas.js';

const logger = createChildLogger('WebhookService');

type WebhookViewOptions = {
  revealHeaders?: boolean;
};

export function redactWebhookHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return headers;
  return Object.fromEntries(Object.keys(headers).map((key) => [key, '********']));
}

export class NotificationWebhookService {
  private eventBus?: EventBusService;

  constructor(
    private db: DrizzleClient,
    private auditService: AuditService,
    private cryptoService: CryptoService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  private emitWebhook(id: string, action: string) {
    this.eventBus?.publish('notification.webhook.changed', { id, action });
  }

  async list(query: WebhookListQuery, options: WebhookViewOptions = {}) {
    const conditions: SQL[] = [];

    if (query.search) {
      conditions.push(ilike(notificationWebhooks.name, `%${query.search}%`));
    }
    if (query.enabled !== undefined) {
      conditions.push(eq(notificationWebhooks.enabled, query.enabled));
    }

    const where = buildWhere(conditions);
    const [totalResult] = await this.db.select({ count: count() }).from(notificationWebhooks).where(where);
    const total = totalResult?.count ?? 0;

    const offset = (query.page - 1) * query.limit;
    const rows = await this.db
      .select()
      .from(notificationWebhooks)
      .where(where)
      .orderBy(notificationWebhooks.createdAt)
      .limit(query.limit)
      .offset(offset);

    const data = rows.map((r) => ({
      ...r,
      signingSecret: r.signingSecret ? '********' : null,
      headers: options.revealHeaders ? r.headers : redactWebhookHeaders(r.headers),
    }));

    return {
      data,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async getById(id: string, options: WebhookViewOptions = {}) {
    const [webhook] = await this.db.select().from(notificationWebhooks).where(eq(notificationWebhooks.id, id)).limit(1);
    if (!webhook) throw new AppError(404, 'NOT_FOUND', 'Webhook not found');
    return {
      ...webhook,
      signingSecret: webhook.signingSecret ? '********' : null,
      headers: options.revealHeaders ? webhook.headers : redactWebhookHeaders(webhook.headers),
    };
  }

  /** Get raw webhook (with encrypted secret) for dispatch */
  async getRaw(id: string) {
    const [webhook] = await this.db.select().from(notificationWebhooks).where(eq(notificationWebhooks.id, id)).limit(1);
    if (!webhook) throw new AppError(404, 'NOT_FOUND', 'Webhook not found');
    return webhook;
  }

  /** Get multiple raw webhooks by IDs (for dispatch) */
  async getRawByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return this.db.select().from(notificationWebhooks).where(inArray(notificationWebhooks.id, ids));
  }

  async create(input: CreateWebhookInput, userId: string) {
    let encryptedSecret: string | null = null;
    if (input.signingSecret) {
      const enc = this.cryptoService.encryptPrivateKey(input.signingSecret);
      encryptedSecret = JSON.stringify(enc);
    }

    const [webhook] = await this.db
      .insert(notificationWebhooks)
      .values({
        name: input.name,
        url: input.url,
        method: input.method,
        enabled: input.enabled,
        signingSecret: encryptedSecret,
        signingHeader: input.signingHeader,
        templatePreset: input.templatePreset ?? null,
        bodyTemplate: input.bodyTemplate ?? null,
        headers: input.headers,
      })
      .returning();

    await this.auditService.log({
      userId,
      action: 'notification_webhook_created',
      resourceType: 'notification_webhook',
      resourceId: webhook.id,
      details: { name: input.name, url: input.url },
    });

    logger.info('Webhook created', { id: webhook.id, name: input.name });
    this.emitWebhook(webhook.id, 'created');
    return { ...webhook, signingSecret: webhook.signingSecret ? '********' : null };
  }

  async update(id: string, input: UpdateWebhookInput, userId: string) {
    const existing = await this.getRaw(id);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) updates.name = input.name;
    if (input.url !== undefined) updates.url = input.url;
    if (input.method !== undefined) updates.method = input.method;
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.signingHeader !== undefined) updates.signingHeader = input.signingHeader;
    if (input.templatePreset !== undefined) updates.templatePreset = input.templatePreset;
    if (input.bodyTemplate !== undefined) updates.bodyTemplate = input.bodyTemplate;
    if (input.headers !== undefined) updates.headers = input.headers;

    if (input.signingSecret === null) {
      updates.signingSecret = null;
    } else if (input.signingSecret) {
      const enc = this.cryptoService.encryptPrivateKey(input.signingSecret);
      updates.signingSecret = JSON.stringify(enc);
    }

    const [updated] = await this.db
      .update(notificationWebhooks)
      .set(updates)
      .where(eq(notificationWebhooks.id, id))
      .returning();

    await this.auditService.log({
      userId,
      action: 'notification_webhook_updated',
      resourceType: 'notification_webhook',
      resourceId: id,
      details: { name: existing.name, changes: Object.keys(updates).filter((k) => k !== 'updatedAt') },
    });

    logger.info('Webhook updated', { id, name: updated.name });
    this.emitWebhook(id, 'updated');
    return { ...updated, signingSecret: updated.signingSecret ? '********' : null };
  }

  async delete(id: string, userId: string) {
    const existing = await this.getById(id);
    await this.db.delete(notificationWebhooks).where(eq(notificationWebhooks.id, id));

    await this.auditService.log({
      userId,
      action: 'notification_webhook_deleted',
      resourceType: 'notification_webhook',
      resourceId: id,
      details: { name: existing.name },
    });

    logger.info('Webhook deleted', { id, name: existing.name });
    this.emitWebhook(id, 'deleted');
  }

  decryptSigningSecret(encryptedJson: string): string | null {
    try {
      const parsed = JSON.parse(encryptedJson);
      return this.cryptoService.decryptPrivateKey(parsed);
    } catch {
      return null;
    }
  }
}
