import { and, count, desc, eq, lt, ne, type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { notificationDeliveryLog, notificationWebhooks } from '@/db/schema/index.js';
import { buildWhere } from '@/lib/utils.js';
import { redactWebhookUrl } from './notification-webhook.service.js';

const DELIVERY_BODY_PREVIEW_CHARS = 2048;

function bodyPreview(value: string | null): { preview: string | null; truncated: boolean } {
  if (value == null) return { preview: null, truncated: false };
  return {
    preview: value.length > DELIVERY_BODY_PREVIEW_CHARS ? value.slice(0, DELIVERY_BODY_PREVIEW_CHARS) : value,
    truncated: value.length > DELIVERY_BODY_PREVIEW_CHARS,
  };
}

interface DeliveryListQuery {
  page: number;
  limit: number;
  webhookId?: string;
  status?: string;
  eventType?: string;
}

export class NotificationDeliveryService {
  constructor(private db: DrizzleClient) {}

  async list(query: DeliveryListQuery, options: { revealSensitive?: boolean } = {}) {
    const conditions: SQL[] = [];

    if (query.webhookId) {
      conditions.push(eq(notificationDeliveryLog.webhookId, query.webhookId));
    }
    if (query.status) {
      conditions.push(eq(notificationDeliveryLog.status, query.status));
    }
    if (query.eventType) {
      conditions.push(eq(notificationDeliveryLog.eventType, query.eventType));
    }

    const where = buildWhere(conditions);
    const [totalResult] = await this.db.select({ count: count() }).from(notificationDeliveryLog).where(where);
    const total = totalResult?.count ?? 0;

    const offset = (query.page - 1) * query.limit;
    const rows = await this.db
      .select({
        id: notificationDeliveryLog.id,
        webhookId: notificationDeliveryLog.webhookId,
        webhookName: notificationWebhooks.name,
        eventType: notificationDeliveryLog.eventType,
        severity: notificationDeliveryLog.severity,
        requestUrl: notificationDeliveryLog.requestUrl,
        requestMethod: notificationDeliveryLog.requestMethod,
        requestBody: sql<string | null>`substring(${notificationDeliveryLog.requestBody} from 1 for ${
          DELIVERY_BODY_PREVIEW_CHARS + 1
        })`,
        responseStatus: notificationDeliveryLog.responseStatus,
        responseBody: sql<string | null>`substring(${notificationDeliveryLog.responseBody} from 1 for ${
          DELIVERY_BODY_PREVIEW_CHARS + 1
        })`,
        responseTimeMs: notificationDeliveryLog.responseTimeMs,
        attempt: notificationDeliveryLog.attempt,
        maxAttempts: notificationDeliveryLog.maxAttempts,
        nextRetryAt: notificationDeliveryLog.nextRetryAt,
        status: notificationDeliveryLog.status,
        error: notificationDeliveryLog.error,
        createdAt: notificationDeliveryLog.createdAt,
        completedAt: notificationDeliveryLog.completedAt,
      })
      .from(notificationDeliveryLog)
      .leftJoin(notificationWebhooks, eq(notificationDeliveryLog.webhookId, notificationWebhooks.id))
      .where(where)
      .orderBy(desc(notificationDeliveryLog.createdAt))
      .limit(query.limit)
      .offset(offset);

    return {
      data: rows.map((row) => {
        const request = bodyPreview(row.requestBody);
        const response = bodyPreview(row.responseBody);
        return {
          ...row,
          requestUrl: options.revealSensitive ? row.requestUrl : redactWebhookUrl(row.requestUrl),
          requestBody: undefined,
          responseBody: undefined,
          requestBodyPreview: options.revealSensitive ? request.preview : null,
          requestBodyTruncated: options.revealSensitive ? request.truncated : false,
          responseBodyPreview: options.revealSensitive ? response.preview : null,
          responseBodyTruncated: options.revealSensitive ? response.truncated : false,
        };
      }),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async getById(id: string, options: { revealSensitive?: boolean } = {}) {
    const [row] = await this.db
      .select()
      .from(notificationDeliveryLog)
      .where(eq(notificationDeliveryLog.id, id))
      .limit(1);
    if (!row) return null;
    if (options.revealSensitive) return row;
    return {
      ...row,
      requestUrl: redactWebhookUrl(row.requestUrl),
      requestBody: null,
      responseBody: null,
    };
  }

  /** Get deliveries pending retry (nextRetryAt <= now) */
  async getPendingRetries(limit: number) {
    return this.db
      .select()
      .from(notificationDeliveryLog)
      .where(and(eq(notificationDeliveryLog.status, 'retrying'), lt(notificationDeliveryLog.nextRetryAt, new Date())))
      .limit(limit);
  }

  /** Clean old delivery log entries (for housekeeping) */
  async cleanOldEntries(retentionDays: number): Promise<number> {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - retentionDays);

    const result = await this.db
      .delete(notificationDeliveryLog)
      .where(and(lt(notificationDeliveryLog.createdAt, threshold), ne(notificationDeliveryLog.status, 'retrying')))
      .returning({ id: notificationDeliveryLog.id });

    return result.length;
  }

  /** Delivery stats for UI dashboard */
  async getStats(webhookId?: string) {
    const conditions: SQL[] = [];
    if (webhookId) {
      conditions.push(eq(notificationDeliveryLog.webhookId, webhookId));
    }

    const where = buildWhere(conditions);

    const [totalResult] = await this.db.select({ count: count() }).from(notificationDeliveryLog).where(where);
    const [successResult] = await this.db
      .select({ count: count() })
      .from(notificationDeliveryLog)
      .where(buildWhere([...conditions, eq(notificationDeliveryLog.status, 'success')]));
    const [failedResult] = await this.db
      .select({ count: count() })
      .from(notificationDeliveryLog)
      .where(buildWhere([...conditions, eq(notificationDeliveryLog.status, 'failed')]));
    const [retryingResult] = await this.db
      .select({ count: count() })
      .from(notificationDeliveryLog)
      .where(buildWhere([...conditions, eq(notificationDeliveryLog.status, 'retrying')]));

    return {
      total: totalResult?.count ?? 0,
      success: successResult?.count ?? 0,
      failed: failedResult?.count ?? 0,
      retrying: retryingResult?.count ?? 0,
    };
  }
}
