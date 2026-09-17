import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { CreateLoggingSchemaInput, UpdateLoggingSchemaInput } from './logging.schemas.js';
import type { LoggingSchemaView } from './logging-storage.types.js';
export class LoggingSchemaService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_db: DrizzleClient, _auditService: AuditService) {}
  setEventBus(_eventBus: EventBusService): void {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  async list(_query?: { search?: string }): Promise<LoggingSchemaView[]> {
    return [];
  }
  async get(_id: string): Promise<LoggingSchemaView> {
    return commercialModuleUnavailable();
  }
  async getBySlug(_slug: string): Promise<LoggingSchemaView> {
    return commercialModuleUnavailable();
  }
  async create(_input: CreateLoggingSchemaInput, _userId: string): Promise<LoggingSchemaView> {
    return commercialModuleUnavailable();
  }
  async update(_id: string, _input: UpdateLoggingSchemaInput, _userId: string): Promise<LoggingSchemaView> {
    return commercialModuleUnavailable();
  }
  async delete(_id: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
}
