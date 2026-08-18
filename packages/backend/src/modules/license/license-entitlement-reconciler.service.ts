import { createChildLogger } from '@/lib/logger.js';
import type { LoggingRuntimeService } from '@/modules/logging/logging-runtime.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { LicensePolicyService } from './license-policy.service.js';

const logger = createChildLogger('LicenseEntitlementReconciler');

export class LicenseEntitlementReconcilerService {
  private unsubscribe: (() => void) | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly policy: LicensePolicyService,
    private readonly settings: GeneralSettingsService,
    private readonly logging: LoggingRuntimeService,
    private readonly eventBus: EventBusService
  ) {}

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
  }
}
