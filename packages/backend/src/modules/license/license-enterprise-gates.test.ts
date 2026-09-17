import { describe, expect, it, vi } from 'vitest';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';

function deniedPolicy() {
  const error = new Error('license denied');
  return {
    error,
    hasFeature: vi.fn().mockResolvedValue(false),
    hasFeatureForExistingRuntime: vi.fn().mockResolvedValue(false),
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
});
