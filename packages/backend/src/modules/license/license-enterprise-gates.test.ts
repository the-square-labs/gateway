import { describe, expect, it, vi } from 'vitest';
import { SiemDeliveryService } from '@/modules/audit/siem-delivery.service.js';
import { SiemDestinationService } from '@/modules/audit/siem-destination.service.js';
import { SiemAuditOutboxService } from '@/modules/audit/siem-outbox.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';

function deniedPolicy() {
  const error = new Error('license denied');
  return {
    error,
    hasFeature: vi.fn().mockResolvedValue(false),
    requireFeature: vi.fn(async () => Promise.reject(error)),
  };
}

describe('Enterprise entitlement service boundaries', () => {
  it.each([
    ['PKI', { pkiEnabled: true }, 'internal-pki'],
    ['SIEM', { siemEnabled: true }, 'siem-export'],
  ] as const)('gates enabling %s in general settings', async (_label, features, entitlement) => {
    const service = new GeneralSettingsService({} as never);
    const policy = deniedPolicy();
    service.setLicensePolicyService(policy as never);

    await expect(service.updateConfig({ features })).rejects.toBe(policy.error);
    expect(policy.requireFeature).toHaveBeenCalledWith(entitlement);
  });

  it('gates new SIEM destinations before endpoint or database work', async () => {
    const service = new SiemDestinationService({} as never, {} as never, {} as never, {} as never);
    const policy = deniedPolicy();
    service.setLicensePolicyService(policy as never);

    await expect(service.create({} as never, 'user')).rejects.toBe(policy.error);
    expect(policy.requireFeature).toHaveBeenCalledWith('siem-export');
  });

  it('does not enqueue SIEM audit events without the entitlement', async () => {
    const settings = { isFeatureEnabled: vi.fn().mockResolvedValue(true) };
    const service = new SiemAuditOutboxService({} as never, settings as never);
    const policy = deniedPolicy();
    service.setLicensePolicyService(policy as never);

    await expect(service.isEnabled()).resolves.toBe(false);
    expect(policy.hasFeature).toHaveBeenCalledWith('siem-export');
    expect(settings.isFeatureEnabled).not.toHaveBeenCalled();
  });

  it('does not run background SIEM delivery without the entitlement', async () => {
    const settings = { isFeatureEnabled: vi.fn().mockResolvedValue(true) };
    const service = new SiemDeliveryService({} as never, {} as never, settings as never);
    const policy = deniedPolicy();
    service.setLicensePolicyService(policy as never);

    await service.runDueDeliveries();
    expect(policy.hasFeature).toHaveBeenCalledWith('siem-export');
    expect(settings.isFeatureEnabled).not.toHaveBeenCalled();
  });
});
