import { describe, expect, it, vi } from 'vitest';
import { HousekeepingService } from './housekeeping.service.js';

describe('HousekeepingService system certificate cleanup', () => {
  it('uses the fixed 30-day lifecycle key-retention policy', async () => {
    const service = new HousekeepingService({} as any, {} as any, {} as any, {} as any);
    const destroyRetiredPrivateKeys = vi.fn().mockResolvedValue(3);
    service.setSystemCertificateLifecycleService({ destroyRetiredPrivateKeys } as any);

    await expect((service as any).cleanOrphanedCerts()).resolves.toEqual({ itemsCleaned: 3 });
    expect(destroyRetiredPrivateKeys).toHaveBeenCalledWith(30);
  });
});
