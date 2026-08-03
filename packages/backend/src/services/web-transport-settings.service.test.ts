import { describe, expect, it, vi } from 'vitest';
import { WebTransportSettingsService } from './web-transport-settings.service.js';

function createDb(stored?: unknown) {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(stored === undefined ? [] : [{ value: stored }]) })),
        })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate })) })),
    } as any,
    onConflictDoUpdate,
  };
}

describe('WebTransportSettingsService', () => {
  it('preserves HTTP for an upgraded installation without a stored choice', async () => {
    const { db, onConflictDoUpdate } = createDb();
    await expect(new WebTransportSettingsService(db).initialize()).resolves.toEqual({ tlsEnabled: false });
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it('honors the fresh installer HTTPS bootstrap choice', async () => {
    const { db } = createDb();
    await expect(new WebTransportSettingsService(db, 'https').initialize()).resolves.toEqual({ tlsEnabled: true });
  });

  it('never overwrites a persisted transport selection', async () => {
    const { db, onConflictDoUpdate } = createDb({ tlsEnabled: false });
    await expect(new WebTransportSettingsService(db, 'https').initialize()).resolves.toEqual({ tlsEnabled: false });
    expect(onConflictDoUpdate).not.toHaveBeenCalled();
  });
});
