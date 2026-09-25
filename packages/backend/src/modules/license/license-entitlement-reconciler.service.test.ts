import { describe, expect, it, vi } from 'vitest';
import { EventBusService } from '@/services/event-bus.service.js';
import { LicenseEntitlementReconcilerService } from './license-entitlement-reconciler.service.js';

function makePolicy(current: string[], existing: string[], status = 'expired') {
  return {
    getSummary: vi.fn(async () => ({ status, plan: 'community', entitlements: { features: current } })),
    hasFeature: vi.fn(async (feature: string) => current.includes(feature)),
    hasFeatureForExistingRuntime: vi.fn(async (feature: string) => existing.includes(feature)),
    // Configuration must never be changed by license transitions.
    updateConfig: vi.fn(),
  };
}

describe('LicenseEntitlementReconcilerService', () => {
  it.each([
    'expired',
    'unreachable_grace_expired',
    'revoked',
    'replaced',
    'deactivated',
  ])('never changes stored configuration after %s', async (status) => {
    const policy = makePolicy([], ['siem-export', 'git-push-to-deploy', 'internal-pki', 'pages'], status);
    const reconciler = new LicenseEntitlementReconcilerService(policy as never, new EventBusService());

    await reconciler.start();
    await reconciler.stop();

    expect(policy.hasFeature).toHaveBeenCalledWith('siem-export');
    expect(policy.hasFeature).toHaveBeenCalledWith('git-push-to-deploy');
    expect(policy.updateConfig).not.toHaveBeenCalled();
  });

  it('re-evaluates paid service features on every license change', async () => {
    const eventBus = new EventBusService();
    const policy = makePolicy(['siem-export', 'git-push-to-deploy'], ['siem-export', 'git-push-to-deploy'], 'valid');
    const reconciler = new LicenseEntitlementReconcilerService(policy as never, eventBus);
    await reconciler.start();
    expect(policy.getSummary).toHaveBeenCalledTimes(1);

    policy.hasFeature.mockResolvedValue(false);
    eventBus.publish('system.license.changed', { status: 'expired' } as never);
    await reconciler.reconcile();
    await reconciler.stop();

    expect(policy.getSummary.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(policy.hasFeatureForExistingRuntime).toHaveBeenCalledWith('siem-export');
  });
});
