import type { DrizzleClient } from '@/db/client.js';
import type { SiemDeliveryStatus } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
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
export class SiemDestinationService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _auditService: AuditService,
    _cryptoService: CryptoService,
    _transport: SiemTransportService
  ) {}
  setEventBus(_eventBus: EventBusService): void {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  async list(query: SiemDestinationListQuery): Promise<{
    data: {
      id: string;
      name: string;
      url: string;
      authType: import('@/db/schema/index.js').SiemAuthType;
      customHeaderName: string | null;
      secretConfigured: boolean;
      enabled: boolean;
      pendingDeliveries: number;
      lastDeliveryStatus: SiemDeliveryStatus;
      lastDeliveryAt: Date;
      createdAt: Date;
      updatedAt: Date;
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
    name: string;
    url: string;
    authType: import('@/db/schema/index.js').SiemAuthType;
    customHeaderName: string | null;
    secretConfigured: boolean;
    enabled: boolean;
    pendingDeliveries: number;
    lastDeliveryStatus: SiemDeliveryStatus;
    lastDeliveryAt: Date;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async getRaw(_id: string): Promise<{
    id: string;
    name: string;
    url: string;
    authType: import('@/db/schema/index.js').SiemAuthType;
    customHeaderName: string | null;
    encryptedSecret: string;
    enabled: boolean;
    deletedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async create(
    _input: CreateSiemDestinationInput,
    _userId: string
  ): Promise<{
    id: string;
    name: string;
    url: string;
    authType: import('@/db/schema/index.js').SiemAuthType;
    customHeaderName: string | null;
    secretConfigured: boolean;
    enabled: boolean;
    pendingDeliveries: number;
    lastDeliveryStatus: SiemDeliveryStatus;
    lastDeliveryAt: Date;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async update(
    _id: string,
    _input: UpdateSiemDestinationInput,
    _userId: string
  ): Promise<{
    id: string;
    name: string;
    url: string;
    authType: import('@/db/schema/index.js').SiemAuthType;
    customHeaderName: string | null;
    secretConfigured: boolean;
    enabled: boolean;
    pendingDeliveries: number;
    lastDeliveryStatus: SiemDeliveryStatus;
    lastDeliveryAt: Date;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async delete(
    _id: string,
    _userId: string
  ): Promise<{
    discardedDeliveries: number;
  }> {
    return commercialModuleUnavailable();
  }
  async test(_id: string): Promise<import('./siem-transport.service.js').SiemTransportResult> {
    return commercialModuleUnavailable();
  }
}
