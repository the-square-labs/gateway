import { describe, expect, it, vi } from 'vitest';
import { LicenseQuotaService } from './license-quota.service.js';

describe('LicenseQuotaService', () => {
  it('holds one transaction across the advisory lock, quota check, and write', async () => {
    const order: string[] = [];
    const tx = {
      execute: vi.fn(async () => {
        order.push('lock');
      }),
    };
    const db = {
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    const policy = {
      requireQuota: vi.fn(async () => {
        order.push('policy');
      }),
    };
    const quota = new LicenseQuotaService(db as never, policy as never);

    const result = await quota.run(
      'users',
      async (executor) => {
        expect(executor).toBe(tx);
        order.push('count');
        return 9;
      },
      async (executor) => {
        expect(executor).toBe(tx);
        order.push('write');
        return 'created';
      }
    );

    expect(result).toBe('created');
    expect(order).toEqual(['lock', 'count', 'policy', 'write']);
    expect(policy.requireQuota).toHaveBeenCalledWith('users', 9);
  });
});
