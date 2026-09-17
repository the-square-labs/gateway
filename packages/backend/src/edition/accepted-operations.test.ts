import { describe, expect, it } from 'vitest';
import { acceptedOperations } from './accepted-operations.js';

describe('accepted operation lifetime', () => {
  it('shares admission across awaited service calls and preserves synchronous return types', async () => {
    expect(acceptedOperations.isActive()).toBe(false);
    expect(acceptedOperations.run(() => 42)).toBe(42);
    await acceptedOperations.run(async () => {
      await Promise.resolve();
      expect(acceptedOperations.isActive()).toBe(true);
      await acceptedOperations.run(async () => {
        expect(acceptedOperations.isActive()).toBe(true);
      });
      expect(acceptedOperations.isActive()).toBe(true);
    });
    expect(acceptedOperations.isActive()).toBe(false);
  });

  it('does not grant detached callbacks admission after their originating operation settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detached!: Promise<boolean>;
    await acceptedOperations.run(async () => {
      detached = gate.then(() => acceptedOperations.isActive());
      await Promise.resolve();
    });
    release();
    await expect(detached).resolves.toBe(false);
  });

  it('revokes admission on rejected and throwing operations', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detached!: Promise<boolean>;
    await expect(
      acceptedOperations.run(async () => {
        detached = gate.then(() => acceptedOperations.isActive());
        throw new Error('failed');
      })
    ).rejects.toThrow('failed');
    release();
    await expect(detached).resolves.toBe(false);
    expect(() =>
      acceptedOperations.run(() => {
        throw new Error('sync');
      })
    ).toThrow('sync');
    expect(acceptedOperations.isActive()).toBe(false);
  });
});
