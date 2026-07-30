import { describe, expect, it, vi } from 'vitest';
import { GeneralSettingsService } from './general-settings.service.js';

describe('GeneralSettingsService inference feature', () => {
  it('backfills disabled and applies persisted updates without a restart', async () => {
    const limit = vi.fn().mockResolvedValue([
      {
        value: {
          features: { pkiEnabled: true, domainsEnabled: true },
        },
      },
    ]);
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ onConflictDoUpdate })),
      })),
    };
    const service = new GeneralSettingsService(db as never);

    expect((await service.getConfig()).features.inferenceEnabled).toBe(false);
    expect(
      (
        await service.updateConfig({
          features: { inferenceEnabled: true },
        })
      ).features.inferenceEnabled
    ).toBe(true);
    expect((await service.getConfig()).features.inferenceEnabled).toBe(true);
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
  });
});
