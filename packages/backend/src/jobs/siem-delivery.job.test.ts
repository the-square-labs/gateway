import { describe, expect, it, vi } from 'vitest';
import { SiemDeliveryJob } from './siem-delivery.job.js';

describe('SiemDeliveryJob', () => {
  it('does not deliver queued SIEM records while the feature is disabled', async () => {
    const deliveryService = { runDueDeliveries: vi.fn() };
    const generalSettingsService = { isFeatureEnabled: vi.fn().mockResolvedValue(false) };
    const job = new SiemDeliveryJob(deliveryService as never, generalSettingsService as never);

    await job.run();

    expect(generalSettingsService.isFeatureEnabled).toHaveBeenCalledWith('siemEnabled');
    expect(deliveryService.runDueDeliveries).not.toHaveBeenCalled();
  });

  it('delivers queued SIEM records while the feature is enabled', async () => {
    const deliveryService = { runDueDeliveries: vi.fn().mockResolvedValue(undefined) };
    const generalSettingsService = { isFeatureEnabled: vi.fn().mockResolvedValue(true) };
    const job = new SiemDeliveryJob(deliveryService as never, generalSettingsService as never);

    await job.run();

    expect(deliveryService.runDueDeliveries).toHaveBeenCalledOnce();
  });
});
