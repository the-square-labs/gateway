import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { InferenceBudgetLockService } from './inference-budget-lock.service.js';

describe('InferenceBudgetLockService', () => {
  it('holds a transaction-scoped advisory lock for the complete budget mutation', async () => {
    const order: string[] = [];
    const transaction = {
      execute: vi.fn().mockImplementation(async () => order.push('lock')),
    };
    const database = {
      transaction: vi.fn().mockImplementation(async (work) => work(transaction)),
    };
    const service = new InferenceBudgetLockService(database as never);

    const result = await service.withUserLock('user-1', async (lockedDatabase) => {
      expect(lockedDatabase).toBe(transaction);
      order.push('work');
      return 42;
    });

    expect(result).toBe(42);
    expect(order).toEqual(['lock', 'work']);
  });

  it('can serialize provider budget admission inside the user transaction', async () => {
    const transaction = { execute: vi.fn().mockResolvedValue(undefined) };
    const database = { transaction: vi.fn().mockImplementation(async (work) => work(transaction)) };
    const service = new InferenceBudgetLockService(database as never);

    await service.withUserLock('user-1', async (lockedDatabase) => {
      await service.lockProviderConnection(lockedDatabase, 'connection-1');
    });

    expect(transaction.execute).toHaveBeenCalledTimes(2);
  });
});
