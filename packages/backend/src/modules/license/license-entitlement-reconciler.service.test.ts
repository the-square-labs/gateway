import { describe, expect, it, vi } from 'vitest';
import { EventBusService } from '@/services/event-bus.service.js';
import { LicenseEntitlementReconcilerService } from './license-entitlement-reconciler.service.js';

function makeServices(features: string[]) {
  const policy = {
    getSummary: vi.fn(async () => ({
      status: 'community',
      plan: 'community',
      entitlements: { features },
    })),
  };
  const config = {
    features: { pkiEnabled: true, siemEnabled: true },
  };
  const settings = {
    getConfig: vi.fn(async () => config),
    updateConfig: vi.fn(async ({ features: updates }) => {
      Object.assign(config.features, updates);
      return config;
    }),
  };
  const logging = {
    snapshot: vi.fn(async () => ({ mode: 'external' })),
    update: vi.fn(async () => undefined),
  };
  const eventBus = new EventBusService();
  return {
    reconciler: new LicenseEntitlementReconcilerService(policy as never, settings as never, logging as never, eventBus),
    policy,
    settings,
    logging,
    eventBus,
  };
}

describe('LicenseEntitlementReconcilerService', () => {
  it('disables PKI, SIEM, and structured logging without clearing their stored configuration', async () => {
    const { reconciler, settings, logging } = makeServices([]);

    await reconciler.reconcile();

    expect(settings.updateConfig).toHaveBeenCalledWith({ features: { pkiEnabled: false, siemEnabled: false } });
    expect(logging.update).toHaveBeenCalledWith({ mode: 'disabled' });
  });

  it('never auto-enables switchable features when entitlements return', async () => {
    const { reconciler, settings, logging } = makeServices(['internal-pki', 'siem-export', 'structured-logging']);

    await reconciler.reconcile();

    expect(settings.updateConfig).not.toHaveBeenCalled();
    expect(logging.update).not.toHaveBeenCalled();
  });

  it('reconciles changes published through the existing notification event bus', async () => {
    const { reconciler, policy, eventBus } = makeServices([]);
    await reconciler.start();
    policy.getSummary.mockClear();

    eventBus.publish('system.license.changed', { status: 'expired', plan: 'community' });
    await vi.waitFor(() => expect(policy.getSummary).toHaveBeenCalledOnce());
    await reconciler.stop();
  });
});
