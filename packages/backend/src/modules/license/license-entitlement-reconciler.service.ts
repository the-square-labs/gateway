import { createChildLogger } from '@/lib/logger.js';
import type { DockerInternalRegistryService } from '@/modules/docker/docker-registry-internal.service.js';
import type { LoggingRuntimeService } from '@/modules/logging/logging-runtime.service.js';
import type { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { LicensePolicyService } from './license-policy.service.js';

const logger = createChildLogger('LicenseEntitlementReconciler');

export class LicenseEntitlementReconcilerService {
  private unsubscribe: (() => void) | null = null;
  private pages?: PageProfileService;
  private internalRegistry?: DockerInternalRegistryService;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly policy: LicensePolicyService,
    private readonly settings: GeneralSettingsService,
    private readonly logging: LoggingRuntimeService,
    private readonly eventBus: EventBusService
  ) {}

  setPageProfileService(pages: PageProfileService): void {
    this.pages = pages;
  }

  setDockerInternalRegistryService(registry: DockerInternalRegistryService): void {
    this.internalRegistry = registry;
  }

  async start(): Promise<void> {
    if (!this.unsubscribe) {
      this.unsubscribe = this.eventBus.subscribe('system.license.changed', () => {
        void this.enqueue();
      });
    }
    await this.enqueue();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.queue;
  }

  reconcile(): Promise<void> {
    return this.enqueue();
  }

  private enqueue(): Promise<void> {
    this.queue = this.queue.then(
      () => this.reconcileNow(),
      () => this.reconcileNow()
    );
    return this.queue;
  }

  private async reconcileNow(): Promise<void> {
    const license = await this.policy.getSummary();

    // An ordinary expiration or an unavailable license service must never tear down
    // infrastructure that the customer already configured. Policy checks still use
    // Community entitlements and block new paid-only resources and operations.
    if (license.status === 'expired' || license.status === 'unreachable_grace_expired') {
      logger.warn('Preserved existing paid features after non-authoritative entitlement loss', {
        plan: license.plan,
        status: license.status,
      });
      return;
    }

    const features = new Set(license.entitlements.features);
    const current = await this.settings.getConfig();
    const featureUpdates: { pkiEnabled?: false; siemEnabled?: false } = {};

    if (current.features.pkiEnabled && !features.has('internal-pki')) featureUpdates.pkiEnabled = false;
    if (current.features.siemEnabled && !features.has('siem-export')) featureUpdates.siemEnabled = false;

    // LICENSE ENFORCEMENT: Downgrade reconciliation is required by the project license/TOS and must not be bypassed.
    if (Object.keys(featureUpdates).length > 0) {
      await this.settings.updateConfig({ features: featureUpdates });
      logger.warn('Disabled switchable features after license entitlement loss', {
        plan: license.plan,
        status: license.status,
        features: Object.keys(featureUpdates),
      });
    }

    if (!features.has('structured-logging')) {
      const logging = await this.logging.snapshot();
      if (logging.mode !== 'disabled') {
        await this.logging.update({ mode: 'disabled' });
        logger.warn('Disabled structured logging after license entitlement loss', {
          plan: license.plan,
          status: license.status,
        });
      }
    }

    if (!features.has('pages') && this.pages) {
      try {
        await this.pages.disableForEntitlementLoss();
        logger.warn('Disabled Pages immutable previews after license entitlement loss', {
          plan: license.plan,
          status: license.status,
        });
      } catch (error) {
        logger.warn('Failed to disable Pages immutable previews after license entitlement loss', {
          plan: license.plan,
          status: license.status,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!features.has('git-push-to-deploy') && this.internalRegistry) {
      try {
        if (await this.internalRegistry.disableExternalAccessForEntitlementLoss()) {
          logger.warn('Disabled external internal-registry access after Business entitlement loss', {
            plan: license.plan,
            status: license.status,
          });
        }
      } catch (error) {
        logger.warn('Failed to disable external internal-registry access after Business entitlement loss', {
          plan: license.plan,
          status: license.status,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
