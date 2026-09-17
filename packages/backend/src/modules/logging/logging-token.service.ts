import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { CreateLoggingTokenInput } from './logging.schemas.js';
export class LoggingTokenService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_db: DrizzleClient, _auditService: AuditService) {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  setEventBus(_eventBus: EventBusService): void {}
  async list(_environmentId: string): Promise<
    {
      id: string;
      environmentId: string;
      name: string;
      tokenPrefix: string;
      enabled: boolean;
      lastUsedAt: string | null;
      expiresAt: string | null;
      createdById: string | null;
      createdAt: string;
    }[]
  > {
    return [];
  }
  async create(
    _environmentId: string,
    _input: CreateLoggingTokenInput,
    _userId: string
  ): Promise<{
    id: string;
    environmentId: string;
    name: string;
    tokenPrefix: string;
    enabled: boolean;
    lastUsedAt: null;
    expiresAt: string | null;
    createdById: string | null;
    createdAt: string;
    token: string;
  }> {
    return commercialModuleUnavailable();
  }
  async delete(_environmentId: string, _tokenId: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async validate(_rawToken: string): Promise<{
    tokenId: string;
    environmentId: string;
    tokenPrefix: string;
    environment: {
      id: string;
      enabled: true;
      schemaMode: import('@/db/schema/index.js').LoggingSchemaMode;
      retentionDays: number;
      fieldSchema: import('@/db/schema/index.js').LoggingFieldDefinition[];
      rateLimitRequestsPerWindow: number | null;
      rateLimitEventsPerWindow: number | null;
    };
  } | null> {
    return null;
  }
}
