import { and, eq, isNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { type SiemAuditEvent, siemDeliveries, siemDestinations } from '@/db/schema/index.js';
import type { LicenseService } from '@/modules/license/license.service.js';
import {
  hasConfiguredLicenseFeatureForExistingRuntime,
  type LicensePolicyService,
} from '@/modules/license/license-policy.service.js';
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

/**
 * Produces the deliberately small SIEM record and adds one durable delivery
 * record per active destination inside the audit transaction. It does not
 * know how to send HTTP and therefore can never slow down a request path.
 */
export class SiemAuditOutboxService {
  private sourcePromise: Promise<string> | null = null;
  private licensePolicy?: LicensePolicyService;

  constructor(
    private readonly licenseService: LicenseService,
    private readonly generalSettingsService: GeneralSettingsService
  ) {}

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicy = service;
  }

  async isEnabled(): Promise<boolean> {
    try {
      return (
        (await hasConfiguredLicenseFeatureForExistingRuntime(this.licensePolicy, 'siem-export')) &&
        (await this.generalSettingsService.isFeatureEnabled('siemEnabled'))
      );
    } catch {
      // An unavailable settings store must not turn an optional external
      // export into a data-leak path or make the local audit write fail.
      return false;
    }
  }

  async buildEvent(input: SiemAuditEventInput): Promise<SiemAuditEvent> {
    return {
      id: input.auditLogId,
      source: await this.getSource(),
      type: 'com.wiolett.gateway.audit.v1',
      time: input.createdAt.toISOString(),
      data: {
        action: input.action,
        actor: input.actorId ? { id: input.actorId, email: input.actorEmail } : null,
        resource: { type: input.resourceType, id: truncateResourceId(input.resourceId) },
        sourceIp: input.sourceIp,
      },
    };
  }

  async enqueue(tx: DatabaseWriter, auditLogId: string, event: SiemAuditEvent, createdAt: Date): Promise<void> {
    if (!(await this.isEnabled())) return;

    const destinations = await tx
      .select({ id: siemDestinations.id })
      .from(siemDestinations)
      .where(and(eq(siemDestinations.enabled, true), isNull(siemDestinations.deletedAt)))
      .limit(5);

    if (destinations.length === 0) return;
    await tx
      .insert(siemDeliveries)
      .values(
        destinations.map((destination) => ({
          destinationId: destination.id,
          auditLogId,
          payload: event,
          status: 'queued' as const,
          nextRetryAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        }))
      )
      .onConflictDoNothing();
  }

  private getSource(): Promise<string> {
    if (!this.sourcePromise) {
      this.sourcePromise = this.licenseService
        .getInstallationId()
        .then((installationId) => `urn:wiolett:gateway:${installationId}`)
        .catch(() => 'urn:wiolett:gateway');
    }
    return this.sourcePromise;
  }
}

/**
 * audit_log.resource_id is text, so a malformed caller could otherwise make
 * an individual SIEM event larger than the documented batch limit. The ID is
 * an identifier rather than event detail; retaining a bounded prefix is the
 * safe and useful representation for the collector.
 */
function truncateResourceId(value: string | null): string | null {
  return value && value.length > 1024 ? value.slice(0, 1024) : value;
}
