import type { DrizzleClient } from '@/db/client.js';
import type { SiemAuditEvent, SiemDeliveryStatus } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { SiemDeliveryListQuery } from './siem.schemas.js';
import type { SiemTransportService } from './siem-transport.service.js';
export class SiemDeliveryService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _transport: SiemTransportService,
    _generalSettingsService?: GeneralSettingsService | undefined
  ) {}
  setEventBus(_eventBus: EventBusService): void {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  async list(query: SiemDeliveryListQuery): Promise<{
    data: {
      id: string;
      destinationId: string;
      destinationName: string | null;
      destinationUrl: string | null;
      auditLogId: string;
      action: string;
      status: SiemDeliveryStatus;
      attempt: number;
      maxAttempts: number;
      nextRetryAt: Date | null;
      responseStatus: number | null;
      responseTimeMs: number | null;
      error: string | null;
      createdAt: Date;
      completedAt: Date | null;
    }[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    return { data: [], total: 0, page: query.page, limit: query.limit, totalPages: 0 };
  }
  async getById(_id: string): Promise<{
    id: string;
    destinationId: string;
    destinationName: string | null;
    destinationUrl: string | null;
    auditLogId: string;
    payload: SiemAuditEvent;
    status: SiemDeliveryStatus;
    attempt: number;
    maxAttempts: number;
    nextRetryAt: Date | null;
    responseStatus: number | null;
    responseTimeMs: number | null;
    error: string | null;
    createdAt: Date;
    completedAt: Date | null;
  }> {
    return commercialModuleUnavailable();
  }
  async requeue(_id: string): Promise<{
    id: string;
    destinationId: string;
    status: SiemDeliveryStatus;
  }> {
    return commercialModuleUnavailable();
  }
  async cleanOldEntries(_retentionDays: number): Promise<number> {
    return 0;
  }
  async runDueDeliveries(): Promise<void> {}
}
