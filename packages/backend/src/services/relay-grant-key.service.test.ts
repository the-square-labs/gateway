import { describe, expect, it, vi } from 'vitest';
import { GRANT_KEY_PUBLICATION_MS, RelayGrantKeyService } from './relay-grant-key.service.js';

function fixture(pendingCreatedAt: Date) {
  const updates: unknown[] = [];
  const select = vi.fn(() => {
    const query: any = Promise.resolve([{ id: 'pending', status: 'pending', createdAt: pendingCreatedAt }]);
    for (const method of ['from', 'where', 'limit']) query[method] = () => query;
    return query;
  });
  const tx: any = {
    execute: vi.fn(),
    select,
    update: vi.fn(() => ({
      set: (values: unknown) => {
        updates.push(values);
        return { where: async () => [] };
      },
    })),
  };
  const db: any = { transaction: vi.fn((callback: (writer: unknown) => unknown) => callback(tx)) };
  return { service: new RelayGrantKeyService(db, {} as never), updates };
}

describe('RelayGrantKeyService rotation', () => {
  it('publishes a pending key to every relay before it signs grants', async () => {
    const now = new Date('2026-09-24T12:00:00Z');
    const syncSnapshot = vi.fn().mockResolvedValue(1);
    const refreshGrants = vi.fn().mockResolvedValue(undefined);

    // Remote relays learn keys from snapshots within one policy lease; until then they would
    // refuse renewed endpoint grants and close the endpoint's tunnels.
    const early = fixture(new Date(now.getTime() - GRANT_KEY_PUBLICATION_MS + 1_000));
    await expect(early.service.rotateIfDue(now, syncSnapshot, refreshGrants)).resolves.toBe(false);
    expect(syncSnapshot).toHaveBeenCalledOnce();
    expect(early.updates).toEqual([]);
    expect(refreshGrants).not.toHaveBeenCalled();

    const published = fixture(new Date(now.getTime() - GRANT_KEY_PUBLICATION_MS));
    await expect(published.service.rotateIfDue(now, syncSnapshot, refreshGrants)).resolves.toBe(true);
    expect(published.updates).toEqual([
      expect.objectContaining({ status: 'verification_only' }),
      expect.objectContaining({ status: 'active', activatedAt: now }),
    ]);
    expect(refreshGrants).toHaveBeenCalledOnce();
  });

  it('outlasts the relay policy lease', () => {
    expect(GRANT_KEY_PUBLICATION_MS).toBeGreaterThan(15 * 60 * 1000);
  });
});
