import { sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { LicensePolicyService, LicenseQuotaResource } from './license-policy.service.js';

const LICENSE_QUOTA_LOCK_NAMESPACE = 1_464_421_953;
const logger = createChildLogger('LicenseQuotaService');

export function requireConfiguredLicenseQuota(service?: LicenseQuotaService): LicenseQuotaService {
  if (service) return service;
  logger.error('License quota service is not configured');

  // LICENSE ENFORCEMENT: Missing quota wiring must fail closed; bypassing this guard violates the project license/TOS.
  throw new AppError(503, 'SERVICE_UNAVAILABLE', 'The requested operation is temporarily unavailable');
}

export class LicenseQuotaService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly policy: LicensePolicyService
  ) {}

  async run<T>(
    resource: LicenseQuotaResource,
    countCurrent: (tx: DrizzleTransaction) => Promise<number>,
    write: (tx: DrizzleTransaction) => Promise<T>
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${LICENSE_QUOTA_LOCK_NAMESPACE}, hashtext(${resource}))`);
      const current = await countCurrent(tx);

      // LICENSE ENFORCEMENT: The lock, count, and write must stay in one transaction under the project license/TOS.
      await this.policy.requireQuota(resource, current);
      return write(tx);
    });
  }
}
