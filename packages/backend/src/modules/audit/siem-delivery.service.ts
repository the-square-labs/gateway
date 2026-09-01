import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gte, inArray, isNull, lt, lte, or, type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type SiemAuditEvent,
  type SiemAuthType,
  type SiemDeliveryStatus,
  siemDeliveries,
  siemDestinations,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  hasConfiguredLicenseFeatureForExistingRuntime,
  type LicensePolicyService,
  requireConfiguredLicensePolicy,
} from '@/modules/license/license-policy.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { SiemDeliveryListQuery } from './siem.schemas.js';
import type { SiemTransportService } from './siem-transport.service.js';

const logger = createChildLogger('SiemDeliveryService');
const RETRY_DELAYS_MS = [30_000, 120_000, 480_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];
const BATCH_LIMIT = 100;
const BATCH_MAX_BYTES = 256 * 1024;
const LEASE_MS = 60_000;
const MAX_BATCHES_PER_RUN = 20;
const TERMINAL_STATUSES: SiemDeliveryStatus[] = ['delivered', 'failed', 'discarded'];

interface ClaimedDelivery {
  id: string;
  destinationId: string;
  payload: SiemAuditEvent;
  attempt: number;
  maxAttempts: number;
}

interface ClaimedBatch {
  destination: {
    id: string;
    url: string;
    authType: SiemAuthType;
    customHeaderName: string | null;
    encryptedSecret: string;
  };
  deliveries: ClaimedDelivery[];
  leaseToken: string;
}

export class SiemDeliveryService {
  private eventBus?: EventBusService;
  private licensePolicy?: LicensePolicyService;
  private running = false;

  constructor(
    private readonly db: DrizzleClient,
    private readonly transport: SiemTransportService,
    private readonly generalSettingsService?: GeneralSettingsService
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicy = service;
  }

  async list(query: SiemDeliveryListQuery) {
    await this.requireEntitlement();
    const conditions: SQL[] = [];
    if (query.destinationId) conditions.push(eq(siemDeliveries.destinationId, query.destinationId));
    if (query.status) conditions.push(eq(siemDeliveries.status, query.status));
    const where = buildWhere(conditions);
    const [totalResult, rows] = await Promise.all([
      this.db.select({ count: count() }).from(siemDeliveries).where(where),
      this.db
        .select({
          id: siemDeliveries.id,
          destinationId: siemDeliveries.destinationId,
          destinationName: siemDestinations.name,
          destinationUrl: siemDestinations.url,
          auditLogId: siemDeliveries.auditLogId,
          action: sql<string>`${siemDeliveries.payload} -> 'data' ->> 'action'`,
          status: siemDeliveries.status,
          attempt: siemDeliveries.attempt,
          maxAttempts: siemDeliveries.maxAttempts,
          nextRetryAt: siemDeliveries.nextRetryAt,
          responseStatus: siemDeliveries.responseStatus,
          responseTimeMs: siemDeliveries.responseTimeMs,
          error: siemDeliveries.error,
          createdAt: siemDeliveries.createdAt,
          completedAt: siemDeliveries.completedAt,
        })
        .from(siemDeliveries)
        .leftJoin(siemDestinations, eq(siemDeliveries.destinationId, siemDestinations.id))
        .where(where)
        .orderBy(desc(siemDeliveries.createdAt))
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
    ]);
    const total = Number(totalResult[0]?.count ?? 0);
    return { data: rows, total, page: query.page, limit: query.limit, totalPages: Math.ceil(total / query.limit) };
  }

  async getById(id: string) {
    await this.requireEntitlement();
    const [delivery] = await this.db
      .select({
        id: siemDeliveries.id,
        destinationId: siemDeliveries.destinationId,
        destinationName: siemDestinations.name,
        destinationUrl: siemDestinations.url,
        auditLogId: siemDeliveries.auditLogId,
        payload: siemDeliveries.payload,
        status: siemDeliveries.status,
        attempt: siemDeliveries.attempt,
        maxAttempts: siemDeliveries.maxAttempts,
        nextRetryAt: siemDeliveries.nextRetryAt,
        responseStatus: siemDeliveries.responseStatus,
        responseTimeMs: siemDeliveries.responseTimeMs,
        error: siemDeliveries.error,
        createdAt: siemDeliveries.createdAt,
        completedAt: siemDeliveries.completedAt,
      })
      .from(siemDeliveries)
      .leftJoin(siemDestinations, eq(siemDeliveries.destinationId, siemDestinations.id))
      .where(eq(siemDeliveries.id, id))
      .limit(1);
    return delivery ?? null;
  }

  async requeue(id: string) {
    await this.requireEntitlement();
    const now = new Date();
    const [delivery] = await this.db
      .update(siemDeliveries)
      .set({
        status: 'queued',
        attempt: 0,
        nextRetryAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        completedAt: null,
        error: null,
        updatedAt: now,
      })
      .where(and(eq(siemDeliveries.id, id), eq(siemDeliveries.status, 'failed')))
      .returning({ id: siemDeliveries.id, destinationId: siemDeliveries.destinationId, status: siemDeliveries.status });
    if (!delivery)
      throw new AppError(409, 'SIEM_DELIVERY_NOT_REQUEUEABLE', 'Only failed SIEM deliveries can be requeued');
    this.emit(delivery.destinationId, 'requeued');
    return delivery;
  }

  async cleanOldEntries(retentionDays: number): Promise<number> {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - retentionDays);
    const rows = await this.db
      .delete(siemDeliveries)
      .where(and(lt(siemDeliveries.createdAt, threshold), inArray(siemDeliveries.status, TERMINAL_STATUSES)))
      .returning({ id: siemDeliveries.id });
    return rows.length;
  }

  async runDueDeliveries(): Promise<void> {
    if (this.running) return;
    if (!(await hasConfiguredLicenseFeatureForExistingRuntime(this.licensePolicy, 'siem-export'))) return;
    if (!(await this.isFeatureEnabled())) return;
    this.running = true;
    try {
      await this.recoverExpiredLeases();
      for (let batchCount = 0; batchCount < MAX_BATCHES_PER_RUN; batchCount += 1) {
        if (!(await hasConfiguredLicenseFeatureForExistingRuntime(this.licensePolicy, 'siem-export'))) break;
        if (!(await this.isFeatureEnabled())) break;
        const batch = await this.claimNextBatch();
        if (!batch) break;
        if (
          !(await hasConfiguredLicenseFeatureForExistingRuntime(this.licensePolicy, 'siem-export')) ||
          !(await this.isFeatureEnabled())
        ) {
          await this.releaseClaimedBatch(batch);
          break;
        }
        await this.deliver(batch);
      }
    } finally {
      this.running = false;
    }
  }

  private async requireEntitlement(): Promise<void> {
    // LICENSE ENFORCEMENT: SIEM delivery operations require Enterprise under the project license/TOS.
    await requireConfiguredLicensePolicy(this.licensePolicy).requireFeature('siem-export');
  }

  private async recoverExpiredLeases(): Promise<void> {
    const now = new Date();
    const expired = and(eq(siemDeliveries.status, 'delivering'), lt(siemDeliveries.leaseExpiresAt, now));
    const [recovered, exhausted] = await Promise.all([
      this.db
        .update(siemDeliveries)
        .set({
          status: 'retrying',
          nextRetryAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
          error: 'Delivery lease expired; retry scheduled',
          updatedAt: now,
        })
        .where(and(expired, lt(siemDeliveries.attempt, siemDeliveries.maxAttempts)))
        .returning({ destinationId: siemDeliveries.destinationId }),
      this.db
        .update(siemDeliveries)
        .set({
          status: 'failed',
          nextRetryAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          error: 'Delivery lease expired after the final attempt',
          completedAt: now,
          updatedAt: now,
        })
        .where(and(expired, gte(siemDeliveries.attempt, siemDeliveries.maxAttempts)))
        .returning({ destinationId: siemDeliveries.destinationId }),
    ]);
    for (const destination of new Set(recovered.map((row) => row.destinationId)))
      this.emit(destination, 'lease-recovered');
    for (const destination of new Set(exhausted.map((row) => row.destinationId)))
      this.emit(destination, 'lease-exhausted');
  }

  private async claimNextBatch(): Promise<ClaimedBatch | null> {
    const now = new Date();
    const dueCondition = or(
      eq(siemDeliveries.status, 'queued'),
      and(
        eq(siemDeliveries.status, 'retrying'),
        or(isNull(siemDeliveries.nextRetryAt), lte(siemDeliveries.nextRetryAt, now))
      )
    );

    return this.db.transaction(async (tx) => {
      const [first] = await tx
        .select({
          destinationId: siemDeliveries.destinationId,
          destinationUrl: siemDestinations.url,
          destinationAuthType: siemDestinations.authType,
          destinationCustomHeaderName: siemDestinations.customHeaderName,
          destinationSecret: siemDestinations.encryptedSecret,
        })
        .from(siemDeliveries)
        .innerJoin(siemDestinations, eq(siemDeliveries.destinationId, siemDestinations.id))
        .where(and(dueCondition, eq(siemDestinations.enabled, true), isNull(siemDestinations.deletedAt)))
        .orderBy(siemDeliveries.createdAt)
        .limit(1)
        .for('update', { skipLocked: true });
      if (!first) return null;

      const candidates = await tx
        .select({
          id: siemDeliveries.id,
          destinationId: siemDeliveries.destinationId,
          payload: siemDeliveries.payload,
          attempt: siemDeliveries.attempt,
          maxAttempts: siemDeliveries.maxAttempts,
        })
        .from(siemDeliveries)
        .where(and(eq(siemDeliveries.destinationId, first.destinationId), dueCondition))
        .orderBy(siemDeliveries.createdAt)
        .limit(BATCH_LIMIT)
        .for('update', { skipLocked: true });
      const deliveries: ClaimedDelivery[] = [];
      for (const candidate of candidates) {
        const nextEvents = [...deliveries.map((delivery) => delivery.payload), candidate.payload];
        if (
          deliveries.length > 0 &&
          Buffer.byteLength(JSON.stringify({ schemaVersion: 1, events: nextEvents }), 'utf8') > BATCH_MAX_BYTES
        ) {
          break;
        }
        deliveries.push({ ...candidate, attempt: candidate.attempt + 1 });
      }
      if (deliveries.length === 0) return null;

      const leaseToken = randomUUID();
      await tx
        .update(siemDeliveries)
        .set({
          status: 'delivering',
          attempt: sql`${siemDeliveries.attempt} + 1`,
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          updatedAt: now,
        })
        .where(
          inArray(
            siemDeliveries.id,
            deliveries.map((delivery) => delivery.id)
          )
        );

      return {
        destination: {
          id: first.destinationId,
          url: first.destinationUrl,
          authType: first.destinationAuthType,
          customHeaderName: first.destinationCustomHeaderName,
          encryptedSecret: first.destinationSecret,
        },
        deliveries,
        leaseToken,
      };
    });
  }

  private async deliver(batch: ClaimedBatch): Promise<void> {
    const [currentDestination] = await this.db
      .select()
      .from(siemDestinations)
      .where(eq(siemDestinations.id, batch.destination.id))
      .limit(1);
    if (!currentDestination || currentDestination.deletedAt) {
      await this.transitionInactiveBatch(batch, 'discarded', 'Destination deleted before delivery');
      return;
    }
    if (!currentDestination.enabled) {
      await this.transitionInactiveBatch(batch, 'paused', 'Destination is disabled');
      return;
    }
    if (!(await this.isFeatureEnabled())) {
      await this.releaseClaimedBatch(batch);
      return;
    }

    const result = await this.transport.send(
      currentDestination,
      batch.deliveries.map((delivery) => delivery.payload)
    );
    const now = new Date();
    await Promise.all(
      batch.deliveries.map((delivery) => {
        const retryable =
          result.statusCode === undefined ||
          result.statusCode === 408 ||
          result.statusCode === 429 ||
          result.statusCode >= 500;
        const terminalFailure = !retryable || delivery.attempt >= delivery.maxAttempts;
        const status: SiemDeliveryStatus = result.success ? 'delivered' : terminalFailure ? 'failed' : 'retrying';
        const error = result.success
          ? null
          : (result.error ?? `SIEM collector returned HTTP ${result.statusCode ?? 'unknown'}`);
        const nextRetryAt =
          status === 'retrying'
            ? new Date(now.getTime() + RETRY_DELAYS_MS[Math.min(delivery.attempt - 1, RETRY_DELAYS_MS.length - 1)]!)
            : null;
        return this.db
          .update(siemDeliveries)
          .set({
            status,
            responseStatus: result.statusCode ?? null,
            responseTimeMs: result.responseTimeMs,
            error,
            nextRetryAt,
            leaseToken: null,
            leaseExpiresAt: null,
            deliveredAt: result.success ? now : null,
            completedAt: status === 'delivered' || status === 'failed' ? now : null,
            updatedAt: now,
          })
          .where(and(eq(siemDeliveries.id, delivery.id), eq(siemDeliveries.leaseToken, batch.leaseToken)));
      })
    );
    if (!result.success) {
      logger.warn('SIEM delivery batch failed', {
        destinationId: batch.destination.id,
        deliveryCount: batch.deliveries.length,
        statusCode: result.statusCode,
        error: result.error,
      });
    }
    this.emit(batch.destination.id, result.success ? 'delivered' : 'attempted');
  }

  /**
   * A feature toggle may change after this worker has already claimed rows.
   * Return that lease without counting it as a transport attempt so re-enable
   * resumes the same queue immediately and without a hidden retry penalty.
   */
  private async releaseClaimedBatch(batch: ClaimedBatch): Promise<void> {
    const now = new Date();
    await this.db
      .update(siemDeliveries)
      .set({
        status: 'queued',
        attempt: sql<number>`greatest(${siemDeliveries.attempt} - 1, 0)`,
        nextRetryAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          inArray(
            siemDeliveries.id,
            batch.deliveries.map((delivery) => delivery.id)
          ),
          eq(siemDeliveries.leaseToken, batch.leaseToken)
        )
      );
    this.emit(batch.destination.id, 'feature-disabled');
  }

  private async transitionInactiveBatch(
    batch: ClaimedBatch,
    status: Extract<SiemDeliveryStatus, 'paused' | 'discarded'>,
    error: string
  ): Promise<void> {
    const now = new Date();
    await this.db
      .update(siemDeliveries)
      .set({
        status,
        error,
        nextRetryAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        completedAt: status === 'discarded' ? now : null,
        updatedAt: now,
      })
      .where(
        and(
          inArray(
            siemDeliveries.id,
            batch.deliveries.map((delivery) => delivery.id)
          ),
          eq(siemDeliveries.leaseToken, batch.leaseToken)
        )
      );
    this.emit(batch.destination.id, status);
  }

  private emit(destinationId: string, action: string): void {
    this.eventBus?.publish('siem.delivery.changed', { destinationId, action });
  }

  private async isFeatureEnabled(): Promise<boolean> {
    return this.generalSettingsService ? this.generalSettingsService.isFeatureEnabled('siemEnabled') : true;
  }
}
