import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, ilike, inArray, isNull, type SQL } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { type SiemDeliveryStatus, siemDeliveries, siemDestinations } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { AuditService } from './audit.service.js';
import type {
  CreateSiemDestinationInput,
  SiemDestinationListQuery,
  UpdateSiemDestinationInput,
} from './siem.schemas.js';
import type { SiemTransportService } from './siem-transport.service.js';

const logger = createChildLogger('SiemDestinationService');
const MAX_ENABLED_DESTINATIONS = 5;
const ACTIVE_DELIVERY_STATUSES: SiemDeliveryStatus[] = ['queued', 'delivering', 'retrying', 'paused'];

export class SiemDestinationService {
  private eventBus?: EventBusService;
  private licensePolicy?: LicensePolicyService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly cryptoService: CryptoService,
    private readonly transport: SiemTransportService
  ) {}

  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
  }

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicy = service;
  }

  async list(query: SiemDestinationListQuery) {
    await this.requireEntitlement();
    const conditions: SQL[] = [isNull(siemDestinations.deletedAt)];
    if (query.enabled !== undefined) conditions.push(eq(siemDestinations.enabled, query.enabled));
    if (query.search) conditions.push(ilike(siemDestinations.name, `%${query.search}%`));
    const where = buildWhere(conditions);
    const [totalResult, rows] = await Promise.all([
      this.db.select({ count: count() }).from(siemDestinations).where(where),
      this.db
        .select()
        .from(siemDestinations)
        .where(where)
        .orderBy(siemDestinations.createdAt)
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
    ]);
    const data = await Promise.all(rows.map((row) => this.toPublic(row)));
    const total = Number(totalResult[0]?.count ?? 0);
    return { data, total, page: query.page, limit: query.limit, totalPages: Math.ceil(total / query.limit) };
  }

  async getById(id: string) {
    await this.requireEntitlement();
    return this.toPublic(await this.getRaw(id));
  }

  async getRaw(id: string) {
    const [destination] = await this.db
      .select()
      .from(siemDestinations)
      .where(and(eq(siemDestinations.id, id), isNull(siemDestinations.deletedAt)))
      .limit(1);
    if (!destination) throw new AppError(404, 'SIEM_DESTINATION_NOT_FOUND', 'SIEM destination not found');
    return destination;
  }

  async create(input: CreateSiemDestinationInput, userId: string) {
    await this.requireEntitlement();
    await this.assertCapacity(input.enabled);
    await this.transport.validateEndpoint(input.url);
    const now = new Date();
    const [destination] = await this.db
      .insert(siemDestinations)
      .values({
        name: input.name,
        url: input.url,
        authType: input.authType,
        customHeaderName: input.authType === 'custom_header' ? input.customHeaderName : null,
        encryptedSecret: JSON.stringify(this.cryptoService.encryptString(input.secret)),
        enabled: input.enabled,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!destination) throw new AppError(500, 'SIEM_DESTINATION_CREATE_FAILED', 'Failed to create SIEM destination');

    await this.auditService.log({
      userId,
      action: 'siem.destination.create',
      resourceType: 'siem_destination',
      resourceId: destination.id,
      details: this.auditDetails(destination),
    });
    this.emit(destination.id, 'created');
    logger.info('SIEM destination created', { id: destination.id, host: endpointHost(destination.url) });
    return this.toPublic(destination);
  }

  async update(id: string, input: UpdateSiemDestinationInput, userId: string) {
    await this.requireEntitlement();
    const existing = await this.getRaw(id);
    if (input.url !== undefined) await this.transport.validateEndpoint(input.url);
    if (input.authType !== undefined && input.authType !== existing.authType && !input.secret) {
      throw new AppError(400, 'SIEM_SECRET_REQUIRED', 'Provide a new secret when changing the authentication type');
    }
    const authType = input.authType ?? existing.authType;
    const customHeaderName =
      authType === 'custom_header' ? (input.customHeaderName ?? existing.customHeaderName) : null;
    if (authType === 'custom_header' && !customHeaderName) {
      throw new AppError(400, 'SIEM_CUSTOM_HEADER_REQUIRED', 'Custom header authentication requires a header name');
    }
    if (authType !== 'custom_header' && input.customHeaderName !== undefined) {
      throw new AppError(
        400,
        'SIEM_CUSTOM_HEADER_INVALID',
        'Custom header name is only valid with custom header authentication'
      );
    }
    if (input.enabled === true && !existing.enabled) await this.assertCapacity(true, id);

    const now = new Date();
    const updates: Partial<typeof siemDestinations.$inferInsert> = { updatedAt: now };
    if (input.name !== undefined) updates.name = input.name;
    if (input.url !== undefined) updates.url = input.url;
    if (input.authType !== undefined) updates.authType = input.authType;
    if (input.authType !== undefined || input.customHeaderName !== undefined) {
      updates.customHeaderName = customHeaderName;
    }
    if (input.secret !== undefined)
      updates.encryptedSecret = JSON.stringify(this.cryptoService.encryptString(input.secret));
    if (input.enabled !== undefined) updates.enabled = input.enabled;

    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx.update(siemDestinations).set(updates).where(eq(siemDestinations.id, id)).returning();
      if (!row) throw new AppError(404, 'SIEM_DESTINATION_NOT_FOUND', 'SIEM destination not found');
      if (input.enabled === false && existing.enabled) {
        await tx
          .update(siemDeliveries)
          .set({ status: 'paused', nextRetryAt: null, leaseToken: null, leaseExpiresAt: null, updatedAt: now })
          .where(
            and(
              eq(siemDeliveries.destinationId, id),
              inArray(siemDeliveries.status, ['queued', 'delivering', 'retrying'])
            )
          );
      }
      if (input.enabled === true && !existing.enabled) {
        await tx
          .update(siemDeliveries)
          .set({ status: 'queued', nextRetryAt: now, leaseToken: null, leaseExpiresAt: null, updatedAt: now })
          .where(and(eq(siemDeliveries.destinationId, id), eq(siemDeliveries.status, 'paused')));
      }
      return row;
    });

    await this.auditService.log({
      userId,
      action:
        input.enabled !== undefined && input.enabled !== existing.enabled
          ? 'siem.destination.toggle'
          : 'siem.destination.update',
      resourceType: 'siem_destination',
      resourceId: id,
      details: {
        ...this.auditDetails(updated),
        changed: Object.keys(input).filter((key) => key !== 'secret'),
        secretChanged: input.secret !== undefined,
      },
    });
    this.emit(id, 'updated');
    return this.toPublic(updated);
  }

  async delete(id: string, userId: string) {
    const existing = await this.getRaw(id);
    const now = new Date();
    const discarded = await this.db.transaction(async (tx) => {
      await tx
        .update(siemDestinations)
        .set({ enabled: false, deletedAt: now, updatedAt: now })
        .where(eq(siemDestinations.id, id));
      const rows = await tx
        .update(siemDeliveries)
        .set({
          status: 'discarded',
          nextRetryAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now,
          error: 'Destination deleted before delivery',
        })
        .where(and(eq(siemDeliveries.destinationId, id), inArray(siemDeliveries.status, ACTIVE_DELIVERY_STATUSES)))
        .returning({ id: siemDeliveries.id });
      return rows.length;
    });

    await this.auditService.log({
      userId,
      action: 'siem.destination.delete',
      resourceType: 'siem_destination',
      resourceId: id,
      details: { ...this.auditDetails(existing), discardedDeliveries: discarded },
    });
    this.emit(id, 'deleted');
    logger.info('SIEM destination deleted', { id, host: endpointHost(existing.url), discarded });
    return { discardedDeliveries: discarded };
  }

  async test(id: string) {
    await this.requireEntitlement();
    const destination = await this.getRaw(id);
    return this.transport.send(destination, [
      {
        id: randomUUID(),
        source: 'urn:wiolett:gateway:siem-test',
        type: 'com.wiolett.gateway.audit.test.v1',
        time: new Date().toISOString(),
        test: true,
        data: {
          action: 'siem.destination.test',
          actor: null,
          resource: { type: 'siem_destination', id: destination.id },
          sourceIp: null,
        },
      },
    ]);
  }

  private async assertCapacity(enabling: boolean, currentId?: string): Promise<void> {
    if (!enabling) return;
    const [result] = await this.db
      .select({ count: count() })
      .from(siemDestinations)
      .where(and(eq(siemDestinations.enabled, true), isNull(siemDestinations.deletedAt)));
    const active = Number(result?.count ?? 0);
    if (active >= MAX_ENABLED_DESTINATIONS && currentId === undefined) {
      throw new AppError(
        409,
        'SIEM_DESTINATION_LIMIT',
        `A maximum of ${MAX_ENABLED_DESTINATIONS} active SIEM destinations is allowed`
      );
    }
    if (active >= MAX_ENABLED_DESTINATIONS && currentId !== undefined) {
      throw new AppError(409, 'SIEM_DESTINATION_LIMIT', `Disable another SIEM destination before enabling this one`);
    }
  }

  private async requireEntitlement(): Promise<void> {
    // LICENSE ENFORCEMENT: SIEM export operations require Enterprise under the project license/TOS.
    await this.licensePolicy?.requireFeature('siem-export');
  }

  private async toPublic(destination: typeof siemDestinations.$inferSelect) {
    const [pendingResult, lastDelivery] = await Promise.all([
      this.db
        .select({ count: count() })
        .from(siemDeliveries)
        .where(
          and(
            eq(siemDeliveries.destinationId, destination.id),
            inArray(siemDeliveries.status, ACTIVE_DELIVERY_STATUSES)
          )
        ),
      this.db
        .select({ status: siemDeliveries.status, createdAt: siemDeliveries.createdAt })
        .from(siemDeliveries)
        .where(eq(siemDeliveries.destinationId, destination.id))
        .orderBy(desc(siemDeliveries.createdAt))
        .limit(1),
    ]);
    return {
      id: destination.id,
      name: destination.name,
      url: destination.url,
      authType: destination.authType,
      customHeaderName: destination.authType === 'custom_header' ? destination.customHeaderName : null,
      secretConfigured: Boolean(destination.encryptedSecret),
      enabled: destination.enabled,
      pendingDeliveries: Number(pendingResult[0]?.count ?? 0),
      lastDeliveryStatus: lastDelivery[0]?.status ?? null,
      lastDeliveryAt: lastDelivery[0]?.createdAt ?? null,
      createdAt: destination.createdAt,
      updatedAt: destination.updatedAt,
    };
  }

  private auditDetails(
    destination: Pick<
      typeof siemDestinations.$inferSelect,
      'name' | 'url' | 'authType' | 'customHeaderName' | 'enabled'
    >
  ) {
    return {
      name: destination.name,
      endpointHost: endpointHost(destination.url),
      authType: destination.authType,
      customHeaderName: destination.authType === 'custom_header' ? destination.customHeaderName : undefined,
      enabled: destination.enabled,
    };
  }

  private emit(id: string, action: string): void {
    this.eventBus?.publish('siem.destination.changed', { id, action });
  }
}

function endpointHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return 'invalid';
  }
}
