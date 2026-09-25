import { createChildLogger } from '@/lib/logger.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { LicenseFeature, LicensePolicyService } from './license-policy.service.js';

const logger = createChildLogger('LicenseEntitlementReconciler');

/** Paid service features that stop once every grace period has ended. */
const PAID_SERVICE_FEATURES = [
  { feature: 'siem-export', name: 'SIEM forwarding' },
  { feature: 'git-push-to-deploy', name: 'External Docker-client access to the internal registry' },
] as const satisfies ReadonlyArray<{ feature: LicenseFeature; name: string }>;

/**
 * Reports license transitions for paid service features. It never changes stored
 * configuration: SIEM forwarding and external registry access check the current
 * plan (including every grace period) at runtime, so they pause after grace and
 * resume on renewal. Existing workloads, routes, PKI, structured logging, and
 * Pages keep running through continuity.
 */
export class LicenseEntitlementReconcilerService {
  private unsubscribe: (() => void) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly paused = new Set<LicenseFeature>();

  constructor(
    private readonly policy: LicensePolicyService,
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
    for (const { feature, name } of PAID_SERVICE_FEATURES) {
      const [current, existing] = await Promise.all([
        this.policy.hasFeature(feature),
        this.policy.hasFeatureForExistingRuntime(feature),
      ]);
      const paused = !current && existing;
      if (paused && !this.paused.has(feature)) {
        this.paused.add(feature);
        logger.warn(`${name} is paused because the license grace period ended`, {
          plan: license.plan,
          status: license.status,
        });
      } else if (!paused && this.paused.delete(feature) && current) {
        logger.info(`${name} resumed after the license was restored`, { plan: license.plan, status: license.status });
      }
    }
  }
}
