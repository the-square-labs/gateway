import type { DrizzleClient } from '@/db/client.js';
import type { SiemAuditEvent } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { LicenseService } from '@/modules/license/license.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';

type DatabaseWriter = Pick<DrizzleClient, 'select' | 'insert'>;
export interface SiemAuditEventInput {
  auditLogId: string;
  createdAt: Date;
  action: string;
  actorId: string | null;
  actorEmail: string | null;
  resourceType: string;
  resourceId: string | null;
  sourceIp: string | null;
}
export class SiemAuditOutboxService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_licenseService: LicenseService, _generalSettingsService: GeneralSettingsService) {}
  setLicensePolicyService(_service: LicensePolicyService): void {}
  async isEnabled(): Promise<boolean> {
    return false;
  }
  async buildEvent(_input: SiemAuditEventInput): Promise<SiemAuditEvent> {
    return commercialModuleUnavailable();
  }
  async enqueue(_tx: DatabaseWriter, _auditLogId: string, _event: SiemAuditEvent, _createdAt: Date): Promise<void> {}
}
