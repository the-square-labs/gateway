import { describe, expect, it, vi } from 'vitest';
import type { User } from '@/types.js';
import { monthlyVmExpenses } from './hosting-account-summary.js';
import { HOSTING_ACCOUNT_SUMMARY_SNAPSHOT, HostingInventoryService } from './hosting-inventory.service.js';
import type { HostingResourceSnapshot } from './hosting-provider.types.js';

const resource = (amount: string, currency = 'USD', period = 'month') =>
  ({ price: { amount, currency, period, estimated: true } }) as HostingResourceSnapshot;
describe('hosting overview account summary', () => {
  it('sums recurring VM prices rather than month-to-date usage', () => {
    expect(monthlyVmExpenses([resource('6.47'), resource('12')])).toMatchObject({
      amount: '18.47',
      currency: 'USD',
      period: 'month',
    });
    expect(monthlyVmExpenses([], 'USD')?.amount).toBe('0.00');
  });
  it('does not invent a total from partial prices, mixed currencies or hourly usage', () => {
    expect(monthlyVmExpenses([resource('6'), {} as HostingResourceSnapshot])).toBeNull();
    expect(monthlyVmExpenses([resource('6'), resource('7', 'EUR')])).toBeNull();
    expect(monthlyVmExpenses([resource('1', 'USD', 'hour')])).toBeNull();
    expect(monthlyVmExpenses([resource('NaN')])).toBeNull();
  });
  it('reads only the matching authorized Redis snapshot and never contacts the provider', async () => {
    const updatedAt = new Date();
    const summary = {
      balance: { amount: '47.56', currency: 'USD', estimated: false },
      monthlyExpenses: null,
      observedAt: updatedAt.toISOString(),
    };
    const connectors = { get: vi.fn(async () => ({ updatedAt })), adapter: vi.fn() };
    const snapshots = {
      get: vi.fn(async () => ({
        refreshStatus: 'success',
        data: { configurationRevision: updatedAt.toISOString(), summary },
      })),
    };
    const service = new HostingInventoryService(
      {} as never,
      connectors as never,
      {} as never,
      {} as never,
      {} as never,
      snapshots as never
    );
    await expect(service.accountSummary('account', { scopes: [] } as unknown as User)).rejects.toThrow();
    expect(snapshots.get).not.toHaveBeenCalled();
    const user = { scopes: ['hosting:billing:view:account'] } as unknown as User;
    expect(await service.accountSummary('account', user)).toEqual(summary);
    expect(snapshots.get).toHaveBeenCalledWith(HOSTING_ACCOUNT_SUMMARY_SNAPSHOT, 'account');
    connectors.get.mockResolvedValueOnce({ updatedAt: new Date(0) });
    expect(await service.accountSummary('account', user)).toBeNull();
    expect(connectors.adapter).not.toHaveBeenCalled();
  });
});
